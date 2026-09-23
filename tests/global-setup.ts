/**
 * Playwright globalSetup：拉起 e2e 依赖的三个服务（幂等，已在监听则复用）。
 *  - 隔离后端 :9180（连 backend-ts/.env.e2e 指定的 mao_e2e 库，绝不连线上 9080）
 *  - admin dev server :5200（API 代理到 9180）
 *  - desktop dev server :5201（API 指向 9180）
 *
 * 环境准备（建库/迁移/种子/.env.e2e）：bash scripts/e2e-setup.sh
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// playwright 以 CJS 转译加载本文件（根 package.json 无 "type":"module"），
// 不能用 import.meta.url；playwright 总在仓库根目录运行，用 cwd 推导。
const ROOT = process.cwd()
const E2E_ENV_FILE = join(ROOT, 'backend-ts', '.env.e2e')
const API_PORT = 9180

function loadE2EEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (!existsSync(E2E_ENV_FILE)) return env
  for (const raw of readFileSync(E2E_ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    env[line.slice(0, eq).trim()] = value
  }
  return env
}

async function portInUse(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(800) })
    return true
  } catch (err) {
    // ECONNREFUSED = 端口空闲；其他错误（如非 HTTP 服务）也视为占用
    const code = (err as { cause?: { code?: string } }).cause?.code
    return code !== 'ECONNREFUSED'
  }
}

function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      fetch(url)
        .then(() => resolve()) // 任何 HTTP 响应（含 401/404）都说明端口已就绪
        .catch(() => {
          if (Date.now() > deadline) {
            reject(new Error(`等待 ${label}(${url}) 超时`))
            return
          }
          setTimeout(tick, 500)
        })
    }
    tick()
  })
}

const managed: ChildProcess[] = []
for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of managed) child.kill('SIGTERM')
  })
}

async function startIfFree(port: number, label: string, command: string, args: string[], cwd: string, env: Record<string, string>, readyUrl: string): Promise<void> {
  if (await portInUse(port)) {
    console.log(`[e2e] ${label} 已在 :${port} 运行，复用`)
    return
  }
  console.log(`[e2e] 启动 ${label} (:${port})`)
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[e2e:${label}] ${chunk}`)
  })
  child.on('exit', (code) => {
    if (code != null && code !== 0) console.error(`[e2e] ${label} 意外退出 (code=${code})`)
  })
  managed.push(child)
  await waitForHttp(readyUrl, 90_000, label)
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(ROOT, 'backend-ts', 'db', 'migration'))) {
    console.error('[e2e] 请在仓库根目录运行 playwright（npm test）')
    process.exit(1)
  }
  if (!existsSync(E2E_ENV_FILE)) {
    console.error('[e2e] 缺少 backend-ts/.env.e2e。请先运行: bash scripts/e2e-setup.sh')
    process.exit(1)
  }
  const apiBase = `http://localhost:${API_PORT}`
  await startIfFree(
    API_PORT,
    'backend',
    process.execPath,
    ['--import', 'tsx', 'src/main.ts'],
    join(ROOT, 'backend-ts'),
    { ...loadE2EEnv(), FLYWAY_ENABLED: 'false' }, // 建库迁移由 e2e-setup.sh 负责，后端只校验
    `${apiBase}/api/v1/auth/admin/login`,
  )
  await startIfFree(5200, 'admin', 'npx', ['vite'], join(ROOT, 'admin'), { MAO_API_PROXY: apiBase }, 'http://localhost:5200/admin/login')
  await startIfFree(5201, 'desktop', 'npx', ['vite'], join(ROOT, 'desktop'), { VITE_API_BASE_URL: `${apiBase}/api/v1` }, 'http://localhost:5201/')
}
