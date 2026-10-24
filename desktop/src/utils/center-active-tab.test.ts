import { describe, expect, it } from 'vitest'
import { resolveSideTaskRestoreIds, resolveSubagentRestoreId } from './center-active-tab'

// 回归（0.0.343 起的接线）：loadSession 按持久化激活态「点名」还原深层边路任务 /
// 子代理 Tab。此前这段接线内联在 TaskView，无单测；收进本文件后逐条覆盖。
describe('冷启动点名还原目标', () => {
  it('激活态指向深层边路任务且仍在递归列表里：点名恢复该 id', () => {
    const persisted = { type: 'side_task', sideSessionId: 13 }
    expect(resolveSideTaskRestoreIds(persisted, [{ id: 7 }, { id: 13 }])).toEqual(new Set([13]))
  })

  it('激活态指向的边路任务已删除（不在递归列表）：不点名，维持直接子级口径', () => {
    const persisted = { type: 'side_task', sideSessionId: 99 }
    expect(resolveSideTaskRestoreIds(persisted, [{ id: 7 }])).toBeUndefined()
  })

  it('激活态指向子代理：side_task 口径不点名，subagent 口径给出该 id', () => {
    const persisted = { type: 'subagent', sideSessionId: 5 }
    expect(resolveSideTaskRestoreIds(persisted, [{ id: 5 }])).toBeUndefined()
    expect(resolveSubagentRestoreId(persisted, [{ id: 5 }, { id: 6 }])).toBe(5)
  })

  it('子代理已删除：subagent 口径返回 null', () => {
    const persisted = { type: 'subagent', sideSessionId: 9 }
    expect(resolveSubagentRestoreId(persisted, [{ id: 5 }])).toBeNull()
  })

  it('激活态是文件 Tab 或无记录：两个口径都不点名', () => {
    const fileTab = { type: 'file', tabId: 'file:/ws/a.ts' }
    expect(resolveSideTaskRestoreIds(fileTab, [{ id: 7 }])).toBeUndefined()
    expect(resolveSubagentRestoreId(fileTab, [{ id: 5 }])).toBeNull()
    expect(resolveSideTaskRestoreIds(null, [{ id: 7 }])).toBeUndefined()
    expect(resolveSubagentRestoreId(null, [{ id: 5 }])).toBeNull()
  })
})
