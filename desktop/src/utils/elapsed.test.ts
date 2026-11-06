import { describe, expect, it } from 'vitest'
import { formatElapsedMs } from './elapsed'

describe('formatElapsedMs', () => {
  it('秒以下用 ms', () => {
    expect(formatElapsedMs(0)).toBe('0ms')
    expect(formatElapsedMs(999)).toBe('999ms')
  })

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
