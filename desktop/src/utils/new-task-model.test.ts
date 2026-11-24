import { describe, expect, it } from 'vitest'
import { decideNewTaskModel } from './new-task-model'

const visible = (ids: number[]) => new Set(ids)

describe('decideNewTaskModel（新建会话模型三级预填）', () => {
  it('用户手选过：任何情况下都不覆盖', () => {
    expect(decideNewTaskModel({
      touched: true, explicitModelId: 8, agentModelId: 9, visibleModelIds: visible([8, 9]),
    })).toEqual({ action: 'keep' })
    expect(decideNewTaskModel({
      touched: true, explicitModelId: 8, agentModelId: 9, visibleModelIds: visible([]),
    })).toEqual({ action: 'keep' })
  })

  it('未手选：显式模型可见时优先用它', () => {
    expect(decideNewTaskModel({
      explicitModelId: 8, agentModelId: 9, visibleModelIds: visible([8]),
    })).toEqual({ action: 'set', modelId: 8 })
  })

  it('未手选：显式模型不可见但等于 Agent 默认模型 → 仍然用它（服务端放行隐藏默认模型）', () => {
    expect(decideNewTaskModel({
      explicitModelId: 9, agentModelId: 9, visibleModelIds: visible([]),
    })).toEqual({ action: 'set', modelId: 9 })
  })

  it('未手选：显式模型不可见且不是 Agent 默认 → 回落到 Agent 默认模型', () => {
    expect(decideNewTaskModel({
      explicitModelId: 8, agentModelId: 9, visibleModelIds: visible([]),
    })).toEqual({ action: 'set', modelId: 9 })
  })

  it('未手选：没有显式模型时用 Agent 默认模型', () => {
    expect(decideNewTaskModel({
      agentModelId: 9, visibleModelIds: visible([1]),
    })).toEqual({ action: 'set', modelId: 9 })
  })

  it('未手选：Agent 没有默认模型 → 用全局默认', () => {
    expect(decideNewTaskModel({
      explicitModelId: 7, agentModelId: null, visibleModelIds: visible([]),
    })).toEqual({ action: 'global' })
  })
})
