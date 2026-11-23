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
