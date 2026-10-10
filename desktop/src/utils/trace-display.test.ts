import { describe, expect, it } from 'vitest'
import { formatClock, formatTokens, runAttentionBadges, runStatus, summarizeRuns, toolSuccessRate } from './trace-display'
import type { RunTrace, TraceRound } from '../types/trace'

function makeRound(overrides: Partial<TraceRound> = {}): TraceRound {
  return {
    seq: 1,
    modelName: 'step-5',
    scene: 'agent',
    createdAt: '2026-10-10 16:00:00',
    durationMs: 1000,
    firstTokenMs: null,
    retryCount: 0,
    success: true,
    interrupted: false,
    errorMessage: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costMicros: null,
    slow: false,
    expensive: false,
    tools: [],
    ...overrides,
  }
}

function makeRun(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 11,
    userMessagePreview: '帮我改一下登录页',
    startedAt: '2026-10-10 16:00:00',
    segments: [{ kind: 'current', rounds: [makeRound()], unplacedTools: [] }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 60_000,
      costMicros: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      toolSuccess: 2,
      toolError: 0,
    },
    ...overrides,
  }
}

describe('runStatus', () => {
  it('全部轮成功算成功', () => {
    expect(runStatus(makeRun())).toBe('ok')
  })

  it('有轮失败算失败', () => {
    const run = makeRun({ segments: [{ kind: 'current', rounds: [makeRound({ success: false })], unplacedTools: [] }] })
    expect(runStatus(run)).toBe('error')
  })

  it('只有轮中断算中断', () => {
    const run = makeRun({ segments: [{ kind: 'current', rounds: [makeRound({ interrupted: true })], unplacedTools: [] }] })
    expect(runStatus(run)).toBe('interrupted')
  })

  it('失败与中断同时存在时失败优先', () => {
    const run = makeRun({
      segments: [
        {
          kind: 'current',
          rounds: [makeRound({ interrupted: true }), makeRound({ seq: 2, success: false })],
          unplacedTools: [],
        },
      ],
    })
    expect(runStatus(run)).toBe('error')
  })

  it('重试 / 慢 / 贵不改变结果状态', () => {
    const run = makeRun({
      segments: [
        { kind: 'current', rounds: [makeRound({ retryCount: 2, slow: true, expensive: true })], unplacedTools: [] },
      ],
    })
    expect(runStatus(run)).toBe('ok')
  })
})

describe('runAttentionBadges', () => {
  it('干净 run 没有关注点徽标', () => {
    expect(runAttentionBadges(makeRun())).toEqual([])
  })

  it('失败 / 中断不进关注点徽标（由状态图标表达）', () => {
    const run = makeRun({ segments: [{ kind: 'current', rounds: [makeRound({ success: false, interrupted: true })], unplacedTools: [] }] })
    expect(runAttentionBadges(run)).toEqual([])
  })

  it('按 重试 / 慢 / 贵 / 压缩 / 编辑前 顺序收拢过程与阈值类关注点', () => {
    const run = makeRun({
      segments: [
        { kind: 'before_edit', rounds: [makeRound({ retryCount: 1, slow: true, expensive: true })], unplacedTools: [] },
        { kind: 'current', rounds: [makeRound({ seq: 2 })], unplacedTools: [] },
      ],
      markers: [{ kind: 'compaction', atMessageId: 5, detail: '手动 · 压缩 3 条消息 · 节省 100 tokens' }],
    })
    expect(runAttentionBadges(run).map((b) => b.label)).toEqual(['重试', '慢', '贵', '压缩', '编辑前'])
  })
})

describe('summarizeRuns', () => {
  it('空列表汇总为零、成本为 null', () => {
    const summary = summarizeRuns([])
    expect(summary).toMatchObject({ runCount: 0, ok: 0, error: 0, interrupted: 0, wallClockMs: 0, tokens: 0, costMicros: null })
  })

  it('按结果状态计数并累加墙钟 / token / 工具成败', () => {
    const summary = summarizeRuns([
      makeRun({
        runId: 1,
        totals: {
          wallClockMs: 60_000,
          costMicros: 1000,
          promptTokens: 100,
          completionTokens: 20,
          cachedTokens: 30,
          cacheCreationTokens: 5,
          toolSuccess: 2,
          toolError: 1,
        },
      }),
      makeRun({
        runId: 2,
        segments: [{ kind: 'current', rounds: [makeRound({ interrupted: true })], unplacedTools: [] }],
        totals: {
          wallClockMs: 30_000,
          costMicros: 500,
          promptTokens: 10,
          completionTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          toolSuccess: 1,
          toolError: 0,
        },
      }),
      makeRun({
        runId: 3,
        segments: [{ kind: 'current', rounds: [makeRound({ success: false })], unplacedTools: [] }],
        totals: {
          wallClockMs: 10_000,
          costMicros: 200,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          toolSuccess: 0,
          toolError: 3,
        },
      }),
    ])
    expect(summary).toMatchObject({
      runCount: 3,
      ok: 1,
      interrupted: 1,
      error: 1,
      wallClockMs: 100_000,
      tokens: 165,
      costMicros: 1700,
      toolSuccess: 3,
      toolError: 4,
    })
  })

  it('任一 run 未配价时总成本为 null，不把配价 run 的和冒充总成本', () => {
    const summary = summarizeRuns([
      makeRun({ runId: 1, totals: { ...makeRun().totals, costMicros: 1000 } }),
      makeRun({ runId: 2, totals: { ...makeRun().totals, costMicros: null } }),
    ])
    expect(summary.costMicros).toBeNull()
  })
})

describe('toolSuccessRate', () => {
  it('没有工具调用时返回 null', () => {
    expect(toolSuccessRate(summarizeRuns([]))).toBeNull()
  })

  it('按成功率四舍五入', () => {
    const summary = summarizeRuns([
      makeRun({ totals: { ...makeRun().totals, toolSuccess: 95, toolError: 5 } }),
    ])
    expect(toolSuccessRate(summary)).toBe(95)
  })
})

describe('formatClock', () => {
  it('截取时分', () => {
    expect(formatClock('2026-10-10 16:17:05')).toBe('16:17')
  })

  it('兼容 T 分隔与缺秒', () => {
    expect(formatClock('2026-10-10T09:05')).toBe('09:05')
  })

  it('null 返回空串', () => {
    expect(formatClock(null)).toBe('')
  })

  it('无法识别的时间戳原样返回', () => {
    expect(formatClock('昨天')).toBe('昨天')
  })
})

describe('formatTokens', () => {
  it('小于 1 万走千分位', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(9999)).toBe('9,999')
  })

  it('1 万起折算 k', () => {
    expect(formatTokens(20_392)).toBe('20.4k')
  })

  it('百万起折算 M', () => {
    expect(formatTokens(20_392_700)).toBe('20.4M')
  })
})
