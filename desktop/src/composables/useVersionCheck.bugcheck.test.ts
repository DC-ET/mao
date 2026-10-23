import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'app_version'

let store: Map<string, string>
let remote: { version: string; buildTime: string }

/** vitest environment 是 node：localStorage / window / fetch 都要自己 stub。 */
function installBrowserGlobals() {
  store = new Map<string, string>()
  const localStorageStub = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
  ;(globalThis as any).localStorage = localStorageStub
  ;(globalThis as any).window = {
    location: {
      href: 'https://mao.example.com/tasks/1',
      protocol: 'https:',
      origin: 'https://mao.example.com',
      hostname: 'mao.example.com',
      reload: () => {},
      replace: () => {},
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  installBrowserGlobals()
  remote = { version: '1.0.0', buildTime: 'build-0' }
  ;(globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ version: remote.version, buildTime: remote.buildTime }),
  }))
})

afterEach(() => {
  delete (globalThis as any).localStorage
  delete (globalThis as any).window
  delete (globalThis as any).fetch
})

/** 触发一次版本轮询（startPolling 内部立即 checkVersion 一次），返回该模块的响应式状态。 */
async function pollOnce() {
  const { useVersionCheck } = await import('./useVersionCheck')
  const vc = useVersionCheck()
  vc.startPolling()
  await new Promise((resolve) => setTimeout(resolve, 5))
  vc.stopPolling()
  return vc
}

/** 本地记录的版本基线（localStorage['app_version']）。 */
function storedVersion(): string | null {
  const raw = store.get(STORAGE_KEY)
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return raw
  }
}

describe('页面版本检查的本地基线语义', () => {
  it('轮询不得把「本地版本基线」改写成尚未安装的远端版本', async () => {
    // 首次检查：以远端版本为基线（本窗口运行的代码就是该版本）
    const first = await pollOnce()
    expect(first.hasUpdate.value).toBe(false)
    expect(storedVersion()).toBe('1.0.0')

    // 服务端发版 1.1.0：本窗口仍运行 1.0.0 → 提示更新
    remote = { version: '1.1.0', buildTime: 'build-1' }
    const second = await pollOnce()
    expect(second.hasUpdate.value).toBe(true)
    expect(second.newVersion.value).toBe('1.1.0')

    // 基线必须仍然记录「本窗口正在运行的版本」1.0.0，
    // 而不是被轮询改写成尚未安装的 1.1.0（否则其它仍跑旧版本的窗口再也收不到提示）
    expect(storedVersion()).toBe('1.0.0')
  })

  it('远端回滚到本窗口正在运行的版本后，页面更新提示必须撤销', async () => {
    await pollOnce() // 基线同步到 1.0.0

    remote = { version: '1.1.0', buildTime: 'build-1' }
    await pollOnce() // 提示 1.1.0

    // 服务端回滚到 1.0.0：本窗口跑的已经是 1.0.0，不存在新版本
    remote = { version: '1.0.0', buildTime: 'build-0' }
    const third = await pollOnce()
    expect(third.hasUpdate.value).toBe(false)
    expect(third.newVersion.value).toBeNull()
  })
})
