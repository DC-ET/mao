import { describe, expect, it } from 'vitest'
import { avgThroughput, decodingMs, formatAvgThroughput, formatThroughput, throughput } from './throughput'

// 口径来源：trace-display.ts 的计时补全（技术方案 2026-10-22-run-trace-deep-dive §5.7），
// 2026-10-27-llm-output-speed 下沉到此文件供运行轨迹与用量展示共用。
describe('decodingMs', () => {
  it('解码 = 总耗时 − 首字耗时', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: 800 })).toBe(3400)
  })

  it('首字缺失（非流式调用）为 null，显示「—」', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: null })).toBeNull()
  })

  it('总耗时缺失为 null', () => {
    expect(decodingMs({ durationMs: null, firstTokenMs: 800 })).toBeNull()
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

  it('输出缺失时为 null', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: null })).toBeNull()
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

describe('avgThroughput', () => {
  it('加权平均 = Σ输出 ÷ Σ解码秒（不是各行 tps 的算术平均）', () => {
    // 两行：50 tok/s × 170 tokens 与 10 tok/s × 10 tokens；算术平均是 30，加权是 43.3
    expect(avgThroughput({ decodeTokens: 180, decodeMs: 4150 })).toBeCloseTo(43.37, 2)
  })

  it('解码总量为 0（窗口内无可解码行，如全非流式）时为 null', () => {
    expect(avgThroughput({ decodeTokens: 0, decodeMs: 0 })).toBeNull()
  })

  it('输出总量为 0 时为 null，不显示 0 误导', () => {
    expect(avgThroughput({ decodeTokens: 0, decodeMs: 3000 })).toBeNull()
  })
})

describe('formatAvgThroughput', () => {
  it('取 1 位小数 + 单位', () => {
    expect(formatAvgThroughput({ decodeTokens: 180, decodeMs: 4150 })).toBe('43.4 tok/s')
  })

  it('null 显示「—」', () => {
    expect(formatAvgThroughput({ decodeTokens: 0, decodeMs: 0 })).toBe('—')
  })
})
