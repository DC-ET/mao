// 回归：catalog 里声明的集成组必须在 SystemSettingsView 真正接线。
// 背景（V202 浏览器直播）：`browser-live` 组在 integrationFieldCatalog 里写全了（含 type:'switch'），
// 但漏了在 SystemSettingsView 的 INTEGRATION_KEYS / TOC_GROUPS 里登记。症状极具误导性——
// 页面不报错，只是这三行回落到「运行环境」通用分类卡片，被渲染成**文本框**，hint 取 DB description
// （"…开关: 1=开启"），管理员得手输 0/1；而 catalog 里明明已经写好了 switch。
// admin vitest 是 node 环境不挂组件，故读 .vue 源码做结构断言（同仓库既有做法）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTEGRATION_GROUP_CATALOG } from './integrationFieldCatalog'

// admin vitest 是 happy-dom（import.meta.url 非 file URL），按 cwd（=admin/）拼路径
const view = readFileSync(path.resolve(process.cwd(), 'src/views/settings/SystemSettingsView.vue'), 'utf8')

/** 取 INTEGRATION_KEYS = new Set([...]) 里的全部 key（决定行走 IntegrationConfigPanel 而非分类卡片） */
function integrationKeys(): Set<string> {
  const start = view.indexOf('const INTEGRATION_KEYS = new Set([')
  expect(start, '未找到 INTEGRATION_KEYS 声明').toBeGreaterThanOrEqual(0)
  const end = view.indexOf('])', start)
  expect(end, 'INTEGRATION_KEYS 未收尾').toBeGreaterThan(start)
  const block = view.slice(start, end)
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

/** 取 TOC_GROUPS 里 kind: 'integration' 挂载的组名（没挂载 = 页面上根本不渲染这个组） */
function mountedIntegrationGroups(): Set<string> {
  const names = [...view.matchAll(/kind:\s*'integration',\s*name:\s*'([^']+)'/g)].map((m) => m[1])
  return new Set(names)
}

describe('集成组接线：catalog 声明的组必须在 SystemSettingsView 登记并挂载', () => {
  const keys = integrationKeys()
  const mounted = mountedIntegrationGroups()

  it('每个 catalog 组的 key 都在 INTEGRATION_KEYS 中（否则回落分类卡片渲染成文本框）', () => {
    const missing: string[] = []
    for (const group of INTEGRATION_GROUP_CATALOG) {
      for (const key of group.keys) if (!keys.has(key)) missing.push(`${group.name}: ${key}`)
    }
    expect(missing, '这些 key 没进 INTEGRATION_KEYS，会走通用分类卡片（switch/number 全变文本框）').toEqual([])
  })

  it('每个 catalog 组都在 TOC_GROUPS 挂载（没挂载 = 页面上没有这个组）', () => {
    const missing = INTEGRATION_GROUP_CATALOG.map((g) => g.name).filter((name) => !mounted.has(name))
    expect(missing, '这些组在 catalog 里但没在 TOC_GROUPS 挂载，用户看不到').toEqual([])
  })

  it('browser-live 组：三个 key 登记齐、组已挂载、开关字段类型是 switch', () => {
    for (const key of ['browserLive.recordEnabled', 'harness.cleanup.browserReplayTtlDays', 'harness.cleanup.shellOutputMaxAgeDays']) {
      expect(keys, `${key} 未登记进 INTEGRATION_KEYS`).toContain(key)
    }
    expect(mounted).toContain('browser-live')
    const group = INTEGRATION_GROUP_CATALOG.find((g) => g.name === 'browser-live')
    expect(group).toBeDefined()
    const field = group!.fields.find((f) => f.key === 'browserLive.recordEnabled')
    expect(field?.type, '录制开关必须是 switch，不能是文本框').toBe('switch')
  })
})

/**
 * SPECIAL_KEYS 展开后的字面量集合。块里写的是具名常量（CONTAINER_AUTO_UPGRADE_KEY 等），
 * 字面量定义在上方，故先取标识符再回查各自的 const 声明；`...INTEGRATION_KEYS` 展开项
 * 由上一个 describe 覆盖，这里不重复校验。
 */
function specialKeys(): Set<string> {
  const start = view.indexOf('const SPECIAL_KEYS = new Set([')
  expect(start, '未找到 SPECIAL_KEYS 声明').toBeGreaterThanOrEqual(0)
  const end = view.indexOf('])', start)
  expect(end, 'SPECIAL_KEYS 未收尾').toBeGreaterThan(start)
  const block = view.slice(start, end)
  const out = new Set<string>()
  for (const m of block.matchAll(/(?<!\.\.\.)(\b[A-Z][A-Z0-9_]{2,}\b)/g)) {
    const name = m[1]
    const decl = view.match(new RegExp(`const ${name} = '([^']+)'`))
    if (decl) out.add(decl[1])
  }
  return out
}

describe('内部状态键不得漏进通用分类卡片', () => {
  // 背景（V200 browser_deps.status）：这行是浏览器依赖安装状态机的 JSON 落点
  // （not_installed/installing/ready/failed），由 /admin/browser-deps 专用端点维护、
  // 迁移里 editable=0，人类可读的呈现面在「Skills 管理页」browser-use 行。
  // 它没被排除，于是「运行环境」分类卡片把它渲染成一行只读 JSON——对人零信息量，
  // 还被设置搜索收录成死条目。修进 SPECIAL_KEYS 后该卡片 .field-readonly 回到 2 个
  // （workspace.root / skills.dir），E2E admin-settings-cards 的计数断言即守这条。
  it('browser_deps.status 在 SPECIAL_KEYS 中（否则运行环境卡片多一行只读 JSON）', () => {
    expect(specialKeys(), 'browser_deps.status 必须排除：它是内部状态机 JSON，无设置页专属面板').toContain('browser_deps.status')
  })

  it('SPECIAL_KEYS 里既有同类项没被误删（容器开关/菜单可见性/容器域名解析）', () => {
    const keys = specialKeys()
    for (const key of ['runtime.container.autoUpgrade', 'admin.menu.hidden', 'runtime.container.inheritHostHosts', 'runtime.container.extraHosts']) {
      expect(keys, `${key} 应从 SPECIAL_KEYS 消失？它有自己的专属面板，排除是有意的`).toContain(key)
    }
  })
})
