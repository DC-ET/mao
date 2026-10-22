import { describe, expect, it, vi } from 'vitest'
import {
  formatClock,
  formatTokens,
  runAttentionBadges,
  runStatus,
  summarizeRuns,
  toolSuccessRate,
  decodingMs,
  throughput,
  formatThroughput,
  runTimeNodes,
  runTimeWindow,
  timeBandGeometry,
  type TimeBandNode,
} from './trace-display'
import type { RunTrace, TraceRound, TraceTool } from '../types/trace'

// 条带 tooltip 用中文工具名：与面板工具行同一份展示名（runTimeNodes 内部调用）。
vi.mock('./toolDisplay', () => ({ getToolDisplayName: (name: string) => name }))

function makeRound(overrides: Partial<TraceRound> = {}): TraceRound {
  return {
    seq: 1,
    modelName: 'step-5',
    scene: 'agent',
    createdAt: '2026-10-10 16:00:00',
    llmCallId: 101,
    startedAtMs: 0,
    provider: 'anthropic',
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

function makeTool(overrides: Partial<TraceTool> = {}): TraceTool {
  return {
    toolCallId: 'call_1',
    name: 'read_file',
    target: 'a.txt',
    status: 'OK',
    durationMs: 500,
    startedAtMs: 0,
    approvalMark: null,
    actor: null,
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
      tokens: 130,
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

  it('1 万起折算 k，固定两位小数', () => {
    expect(formatTokens(20_392)).toBe('20.39k')
  })

  it('百万起折算 M，固定两位小数', () => {
    expect(formatTokens(20_392_700)).toBe('20.39M')
    expect(formatTokens(1_400_000_000)).toBe('1400.00M')
  })
})

/* ---- 计时补全（技术方案 §5.7） ---- */

describe('decodingMs', () => {
  it('解码 = 总耗时 − 首字耗时', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: 800 })).toBe(3400)
  })

  it('首字缺失（非流式调用）为 null，显示「—」', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: null })).toBeNull()
  })

  it('首字晚于结束（时钟异常）为 null，不出负数', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: 5000 })).toBeNull()
  })

  it('首字等于结束时解码为 0（真实 0，不是异常）', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: 4200 })).toBe(0)
  })
})

describe('throughput', () => {
  it('吞吐 = 输出 tokens ÷ 解码秒', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: 170 })).toBe(50)
  })

  it('解码不可算时为 null', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: null, completionTokens: 170 })).toBeNull()
  })

  it('解码为 0 时为 null，不显示 Infinity', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: 4200, completionTokens: 170 })).toBeNull()
  })

  it('输出为 0 时为 null，不显示 0 tok/s 误导', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: 0 })).toBeNull()
  })
})

describe('formatThroughput', () => {
  it('取 1 位小数 + 单位', () => {
    expect(formatThroughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: 170 })).toBe('50.0 tok/s')
  })

  it('null 显示「—」', () => {
    expect(formatThroughput({ durationMs: 4200, firstTokenMs: null, completionTokens: 170 })).toBe('—')
  })
})

/* ---- 时间概览条带（技术方案 §5.5） ---- */

describe('runTimeNodes', () => {
  it('轮次 / 工具 / 旁路都进节点数组，顺序为轮次 → 未挂轮工具 → 轮内工具 → 旁路', () => {
    const run = makeRun({
      segments: [
        {
          kind: 'before_edit',
          rounds: [makeRound({ seq: 1, tools: [makeTool()] })],
          unplacedTools: [makeTool({ toolCallId: 'call_unplaced', name: 'glob' })],
        },
        { kind: 'current', rounds: [makeRound({ seq: 2 })], unplacedTools: [] },
      ],
      sideCalls: [
        {
          scene: 'title',
          modelName: 'step-mini',
          createdAt: '2026-10-10 16:00:01',
          startedAtMs: 1000,
          provider: 'anthropic',
          durationMs: 200,
          promptTokens: 10,
          completionTokens: 2,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costMicros: null,
          success: true,
        },
      ],
    })
    const nodes = runTimeNodes(run)
    expect(nodes.map((n) => n.key)).toEqual([
      'round:before_edit:1',
      'tool:before_edit:call_unplaced',
      'tool:before_edit:call_1',
      'round:current:2',
      'side:0',
    ])
    expect(nodes.map((n) => n.kind)).toEqual(['round', 'tool', 'tool', 'round', 'side'])
  })

  it('编辑重发时两段 seq 都从 1 起，key 仍唯一（带段维度，不与行锚点撞）', () => {
    const run = makeRun({
      segments: [
        { kind: 'before_edit', rounds: [makeRound({ seq: 1 }), makeRound({ seq: 2 })], unplacedTools: [] },
        { kind: 'current', rounds: [makeRound({ seq: 1 }), makeRound({ seq: 2 }), makeRound({ seq: 3 })], unplacedTools: [] },
      ],
    })
    const keys = runTimeNodes(run).filter((n) => n.kind === 'round').map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([
      'round:before_edit:1', 'round:before_edit:2',
      'round:current:1', 'round:current:2', 'round:current:3',
    ])
  })

  it('同一工具在两段都被调用时 key 不撞（段维度区分）', () => {
    const run = makeRun({
      segments: [
        { kind: 'before_edit', rounds: [makeRound({ seq: 1, tools: [makeTool({ toolCallId: null, name: 'glob' })] })], unplacedTools: [] },
        { kind: 'current', rounds: [makeRound({ seq: 1, tools: [makeTool({ toolCallId: null, name: 'glob' })] })], unplacedTools: [] },
      ],
    })
    const keys = runTimeNodes(run).filter((n) => n.kind === 'tool').map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['tool:before_edit:glob', 'tool:current:glob'])
  })

  it('工具 label 带段后缀：两段同名工具的 tooltip 也能分辨', () => {
    const run = makeRun({
      segments: [
        { kind: 'before_edit', rounds: [makeRound({ seq: 1, tools: [makeTool({ toolCallId: null, name: 'glob' })] })], unplacedTools: [] },
        { kind: 'current', rounds: [makeRound({ seq: 1, tools: [makeTool({ toolCallId: null, name: 'glob' })] })], unplacedTools: [] },
      ],
    })
    const labels = runTimeNodes(run).filter((n) => n.kind === 'tool').map((n) => n.label)
    expect(labels).toEqual(['glob（编辑前）', 'glob（当前）'])
  })

  it('起止不可估算的节点仍进数组（图例要报「N 项未画」）', () => {
    const run = makeRun({
      segments: [{
        kind: 'current',
        rounds: [makeRound({ startedAtMs: null })],
        unplacedTools: [makeTool({ startedAtMs: null })],
      }],
    })
    const nodes = runTimeNodes(run)
    expect(nodes).toHaveLength(2)
    expect(nodes.every((n) => n.startedAtMs == null)).toBe(true)
  })

  it('轮次状态：中断优先于失败', () => {
    const run = makeRun({
      segments: [{ kind: 'current', rounds: [makeRound({ success: false, interrupted: true })], unplacedTools: [] }],
    })
    expect(runTimeNodes(run)[0]!.status).toBe('interrupted')
  })

  it('工具 ERROR 状态映射为 error', () => {
    const run = makeRun({
      segments: [{ kind: 'current', rounds: [makeRound({ tools: [makeTool({ status: 'ERROR' })] })], unplacedTools: [] }],
    })
    expect(runTimeNodes(run).find((n) => n.kind === 'tool')!.status).toBe('error')
  })
})

describe('runTimeWindow', () => {
  it('取全部节点估算起止的 min/max', () => {
    const window = runTimeWindow([
      { key: 'a', kind: 'round', label: 'a', startedAtMs: 5000, durationMs: 1000, firstTokenMs: null, status: 'ok' },
      { key: 'b', kind: 'round', label: 'b', startedAtMs: 4000, durationMs: 4000, firstTokenMs: null, status: 'ok' },
    ])
    expect(window).toEqual({ startMs: 4000, endMs: 8000 })
  })

  it('全 null 返回 null（组件整体不渲染，不画空条）', () => {
    expect(runTimeWindow([
      { key: 'a', kind: 'round', label: 'a', startedAtMs: null, durationMs: null, firstTokenMs: null, status: 'ok' },
    ])).toBeNull()
  })
})

describe('timeBandGeometry', () => {
  const window = { startMs: 1000, endMs: 6000 }

  function node(overrides: Partial<TimeBandNode> = {}): TimeBandNode {
    return {
      key: 'round:1',
      kind: 'round',
      label: '#1',
      startedAtMs: 2000,
      durationMs: 2000,
      firstTokenMs: null,
      status: 'ok',
      ...overrides,
    }
  }

  it('起止不可估算返回 null → 不画色条', () => {
    expect(timeBandGeometry(node({ startedAtMs: null }), window, 100)).toBeNull()
    expect(timeBandGeometry(node({ durationMs: null }), window, 100)).toBeNull()
  })

  it('按窗口比例算 x 与宽', () => {
    expect(timeBandGeometry(node(), window, 100)).toEqual({ x: 20, width: 40, segments: null })
  })

  it('有首字时分两段，两段宽度和恒等于总宽', () => {
    const geo = timeBandGeometry(node({ firstTokenMs: 500 }), window, 100)!
    expect(geo.segments).toHaveLength(2)
    expect(geo.segments![0]!.part).toBe('ttft')
    expect(geo.segments![1]!.part).toBe('decode')
    expect(geo.segments![0]!.width + geo.segments![1]!.width).toBe(geo.width)
    expect(geo.segments![0]!.x).toBe(geo.x)
    expect(geo.segments![1]!.x).toBeCloseTo(geo.x + geo.segments![0]!.width)
  })

  it('首字为 0 或等于总耗时时退化为单段', () => {
    expect(timeBandGeometry(node({ firstTokenMs: 0 }), window, 100)!.segments).toBeNull()
    expect(timeBandGeometry(node({ firstTokenMs: 2000 }), window, 100)!.segments).toBeNull()
  })

  it('单点窗口（startMs === endMs）不除零', () => {
    const geo = timeBandGeometry(node(), { startMs: 5000, endMs: 5000 }, 100)!
    expect(Number.isFinite(geo.x)).toBe(true)
    expect(geo.width).toBeGreaterThan(0)
  })

  it('并行工具色条的 x 区间互相重叠，不相加', () => {
    const a = timeBandGeometry(node({ key: 'tool:a', kind: 'tool', startedAtMs: 2000, durationMs: 2000 }), window, 100)!
    const b = timeBandGeometry(node({ key: 'tool:b', kind: 'tool', startedAtMs: 2500, durationMs: 2000 }), window, 100)!
    expect(b.x).toBeGreaterThan(a.x)
    expect(b.x).toBeLessThan(a.x + a.width)
  })
})
