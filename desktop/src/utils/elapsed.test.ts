import { describe, expect, it, vi } from 'vitest'
import { elapsedBaseMs, formatElapsedMs } from './elapsed'

describe('formatElapsedMs', () => {
  it('一分钟内用秒', () => {
    expect(formatElapsedMs(1000)).toBe('1s')
    expect(formatElapsedMs(59_999)).toBe('59s')
  })

  it('一小时内用 m/s，整分钟不带秒', () => {
    expect(formatElapsedMs(60_000)).toBe('1m')
    expect(formatElapsedMs(90_000)).toBe('1m30s')
    // 59.9s 不能进位成 0m60s
    expect(formatElapsedMs(59_900)).toBe('59s')
    expect(formatElapsedMs(3_599_000)).toBe('59m59s')
  })

  it('一小时以上折算小时，整小时不带分', () => {
    expect(formatElapsedMs(3_600_000)).toBe('1h')
    expect(formatElapsedMs(5_400_000)).toBe('1h30m')
    // 59.9m 不能进位成 1h60m
    expect(formatElapsedMs(3_599_000 - 1)).toBe('59m58s')
  })
})

describe('elapsedBaseMs', () => {
  it('带服务端已耗时：基座回退到「现在 − 已耗时」', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      expect(elapsedBaseMs(90_000)).toBe(910_000)
      expect(elapsedBaseMs(0)).toBe(1_000_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('缺失 / 非法值：退回当前时刻（实时事件收包即开始）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      expect(elapsedBaseMs()).toBe(1_000_000)
      expect(elapsedBaseMs(null)).toBe(1_000_000)
      expect(elapsedBaseMs(-1)).toBe(1_000_000)
      expect(elapsedBaseMs(Number.NaN)).toBe(1_000_000)
    } finally {
      vi.useRealTimers()
    }
  })
})
