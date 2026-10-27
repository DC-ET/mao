import { describe, expect, it } from 'vitest'
import { decodingMs, formatThroughput, formatTps, throughput } from './throughput'

// 与 desktop src/utils/throughput.test.ts 同组边界（口径必须两端一致）。
describe('decodingMs', () => {
  it('解码 = 总耗时 − 首字耗时', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: 800 })).toBe(3400)
  })

  it('首字缺失（非流式调用）为 null', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: null })).toBeNull()
  })

  it('首字晚于结束（时钟异常）为 null，不出负数', () => {
    expect(decodingMs({ durationMs: 4200, firstTokenMs: 5000 })).toBeNull()
  })
})

describe('throughput', () => {
  it('吞吐 = 输出 tokens ÷ 解码秒', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: 170 })).toBe(50)
  })

  it('解码为 0 或输出为 0 时为 null', () => {
    expect(throughput({ durationMs: 4200, firstTokenMs: 4200, completionTokens: 170 })).toBeNull()
    expect(throughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: 0 })).toBeNull()
  })
})

describe('formatThroughput', () => {
  it('取 1 位小数 + 单位；null 显示「-」（admin 空值口径，桌面端是「—」）', () => {
    expect(formatThroughput({ durationMs: 4200, firstTokenMs: 800, completionTokens: 170 })).toBe('50.0 tok/s')
    expect(formatThroughput({ durationMs: 4200, firstTokenMs: null, completionTokens: 170 })).toBe('-')
  })
})

describe('formatTps', () => {
  it('后端聚合值：1 位小数 + 单位', () => {
    expect(formatTps(60)).toBe('60.0 tok/s')
    expect(formatTps(43.37)).toBe('43.4 tok/s')
  })

  it('null / undefined / 非有限值显示「-」', () => {
    expect(formatTps(null)).toBe('-')
    expect(formatTps(undefined)).toBe('-')
    expect(formatTps(Number.NaN)).toBe('-')
  })
})
