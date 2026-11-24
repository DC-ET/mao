// 回归（技术方案 2026-11-24 §8.1）：客户端模型选择器只列客户端可选模型，
// 并把「当前模型不在列表」渲染为只读的「仅管理端」项。
// 组件没有挂载测试依赖（仓库 desktop 侧统一用源码断言），这里锁住关键契约。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('./ModelSelector.vue', import.meta.url), 'utf8')

describe('ModelSelector 客户端可选', () => {
  it('请求带 scope=client', () => {
    expect(src).toMatch(/api\.get\(['"]\/models\/active['"],\s*\{\s*params:\s*\{\s*scope:\s*['"]client['"]\s*\}\s*\}\)/)
  })

  it('当前模型只读项只在「成功加载且不在候选」时显示', () => {
    expect(src).toContain('loadedOk')
    expect(src).toMatch(/if \(!loadedOk\.value \|\| loadingModels\.value \|\| props\.modelId == null\) return false/)
    expect(src).toContain('仅管理端')
  })

  it('只读项不带点击选择', () => {
    const block = src.slice(src.indexOf('currentModelOutsideList'), src.indexOf('v-for="m in models"'))
    expect(block).toContain('readonly')
    expect(block).not.toContain('handleSelect')
  })
})
