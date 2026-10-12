import { describe, expect, it } from 'vitest'
import { formatDigestCost, parseDigestData, shortDate, type DigestData } from './digest-payload'

function fullPayload(): Record<string, unknown> {
  return {
    coveredDate: '2026-10-11',
    digest: {
      coveredDate: '2026-10-11',
      tasks: {
        completed: 3,
        failed: 1,
        failedTop: [{ sessionId: 10, title: '任务甲', reason: '模型超时' }],
      },
      scheduled: { total: 4, completed: 3, failed: 1, paused: [{ taskId: 7, name: '日报' }] },
      watchers: { triggered: 2, disabled: [{ watcherId: 5, name: '汇率' }] },
      approvals: { pending: 2, items: [{ sessionId: 8, title: '有待处理的审批' }] },
      cost: {
        totalMicros: 3_420_000,
        unpricedCalls: 1,
        calls: 6,
        top: [{ agentId: 1, name: '助手A', micros: 3_420_000 }],
      },
      openApi: { total: 12, rejected: 3 },
    },
  }
}

describe('parseDigestData', () => {
  it('完整 payload 六板块全部解析', () => {
    const data = parseDigestData(fullPayload())
    expect(data).not.toBeNull()
    expect(data!.coveredDate).toBe('2026-10-11')
    expect(data!.tasks).toEqual({
      completed: 3,
      failed: 1,
      failedTop: [{ sessionId: 10, title: '任务甲', reason: '模型超时' }],
    })
    expect(data!.cost!.totalMicros).toBe(3_420_000)
    expect(data!.cost!.calls).toBe(6)
    expect(data!.openApi).toEqual({ total: 12, rejected: 3 })
  })

  it('空板块（null）原样保留，不当成对象渲染', () => {
    const payload = fullPayload()
    ;(payload.digest as Record<string, unknown>).tasks = null
    const data = parseDigestData(payload)
    expect(data!.tasks).toBeNull()
  })

  it('payload 缺失 / digest 缺失 / coveredDate 非字符串 → null（对话框降级）', () => {
    expect(parseDigestData(null)).toBeNull()
    expect(parseDigestData({})).toBeNull()
    expect(parseDigestData({ digest: 'oops' })).toBeNull()
    expect(parseDigestData({ digest: { coveredDate: 20261011 } })).toBeNull()
    expect(parseDigestData({ digest: { coveredDate: '' } })).toBeNull()
  })

  it('坏字段逐个容错：数字缺省 0、字符串缺省空、id 缺省 null，不抛', () => {
    const payload = {
      digest: {
        coveredDate: '2026-10-11',
        tasks: { completed: 'x', failedTop: [{ title: '没 id' }, 'not-object', null] },
        cost: { totalMicros: null, top: [{ micros: 'nan' }] },
      },
    }
    const data = parseDigestData(payload)
    expect(data!.tasks!.completed).toBe(0)
    expect(data!.tasks!.failedTop).toEqual([
      { sessionId: null, title: '没 id', reason: '' },
      { sessionId: null, title: '', reason: '' },
      { sessionId: null, title: '', reason: '' },
    ])
    expect(data!.cost!.totalMicros).toBe(0)
    expect(data!.cost!.top).toEqual([{ agentId: null, name: '', micros: 0 }])
  })

  it('cost.calls：正常解析；旧条目缺失时回落 0（对话框不显示免费提示）', () => {
    const withCalls = parseDigestData({
      digest: { coveredDate: '2026-10-11', cost: { totalMicros: 0, unpricedCalls: 0, calls: 3, top: [] } },
    })
    expect(withCalls!.cost).toEqual({ totalMicros: 0, unpricedCalls: 0, calls: 3, top: [] })
    // 修复前写入的条目没有 calls 字段：回落 0 而不是 undefined
    const legacy = parseDigestData({
      digest: { coveredDate: '2026-10-11', cost: { totalMicros: 0, unpricedCalls: 0, top: [] } },
    })
    expect(legacy!.cost!.calls).toBe(0)
  })

  it('数组字段给非数组时按空数组处理', () => {
    const payload = { digest: { coveredDate: '2026-10-11', tasks: { completed: 1, failed: 0, failedTop: 'nope' } } }
    const data = parseDigestData(payload)
    expect(data!.tasks!.failedTop).toEqual([])
  })

  it('六板块全 null 也能解析（安静日不会产生条目，但旧数据/边界要稳）', () => {
    const payload: Record<string, unknown> = {
      digest: { coveredDate: '2026-10-11', tasks: null, scheduled: null, watchers: null, approvals: null, cost: null, openApi: null },
    }
    const data = parseDigestData(payload) as DigestData
    expect(data.tasks).toBeNull()
    expect(data.cost).toBeNull()
  })
})

describe('shortDate / formatDigestCost', () => {
  it('短日期取 MM-DD', () => {
    expect(shortDate('2026-10-11')).toBe('10-11')
  })

  it('成本 micros → ¥ 两位小数', () => {
    expect(formatDigestCost(3_420_000)).toBe('¥3.42')
    expect(formatDigestCost(0)).toBe('¥0.00')
    expect(formatDigestCost(12_345_678)).toBe('¥12.35')
    expect(formatDigestCost(Number.NaN)).toBe('¥0.00')
  })
})
