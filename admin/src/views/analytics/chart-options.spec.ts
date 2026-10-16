import { describe, expect, it } from 'vitest'
import { formatCompact, formatCost, formatTokens } from './chart-options'

/**
 * KPI 口径与图表口径的小数位区分（0.0.301 修复：Token 消耗曾漏改，仍是一位小数）。
 * 单测锁住两档行为，避免再出现「改了 formatCompact/formatCost 却漏了 formatTokens」。
 */
describe('formatCompact', () => {
  it('默认一位小数并去掉整数部分多余的 .0', () => {
    expect(formatCompact(17_000)).toBe('1.7 万')
    expect(formatCompact(20_000)).toBe('2 万')
    expect(formatCompact(120_000_000)).toBe('1.2 亿')
  })

  it('KPI 口径固定两位小数', () => {
    expect(formatCompact(17_000, 2)).toBe('1.70 万')
    expect(formatCompact(20_000, 2)).toBe('2.00 万')
    expect(formatCompact(123_450_000, 2)).toBe('1.23 亿')
  })

  it('万以下原样展示', () => {
    expect(formatCompact(9999)).toBe('9999')
  })
})

describe('formatTokens', () => {
  it('默认一位小数，图表坐标轴与排行标签沿用', () => {
    expect(formatTokens(1_400_000_000)).toBe('1.4B')
    expect(formatTokens(1_500_000_000)).toBe('1.5B')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(20_400)).toBe('20.4K')
  })

  it('KPI 口径固定两位小数：1.4B → 1.40B', () => {
    expect(formatTokens(1_400_000_000, 2)).toBe('1.40B')
    expect(formatTokens(1_450_000_000, 2)).toBe('1.45B')
    expect(formatTokens(2_000_000, 2)).toBe('2.00M')
    expect(formatTokens(20_400, 2)).toBe('20.40K')
  })

  it('小于 1000 不走紧凑单位', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(999, 2)).toBe('999')
  })

  it('负数按绝对值选档，符号保留', () => {
    expect(formatTokens(-1_450_000_000, 2)).toBe('-1.45B')
  })
})

describe('formatCost', () => {
  it('最多两位小数', () => {
    expect(formatCost(144.99)).toBe('144.99')
    expect(formatCost(183.256)).toBe('183.26')
  })

  it('null 与非法值显示 -', () => {
    expect(formatCost(null)).toBe('-')
    expect(formatCost(Number.NaN)).toBe('-')
  })
})
