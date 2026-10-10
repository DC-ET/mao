import { describe, expect, it } from 'vitest'
import { formatCacheHit, formatCompact, formatCost, formatNumber, formatPercent } from './usageFormat'

describe('usageFormat', () => {
  it('formatNumber：千分位；null/undefined 归零', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(null)).toBe('0')
    expect(formatNumber(undefined)).toBe('0')
  })

  it('formatCost：与模型价格填写单位一致，按量级收小数位；null 显示 -', () => {
    expect(formatCost(0.1234)).toBe('0.123')
    expect(formatCost(1.5)).toBe('1.5')
    expect(formatCost(1234.56)).toBe('1,234.6')
    expect(formatCost(12345.6)).toBe('12,346')
    expect(formatCost(null)).toBe('-')
    expect(formatCost(undefined)).toBe('-')
    expect(formatCost(Number.NaN)).toBe('-')
  })

  it('formatCompact：万/亿紧凑单位，不丢整数精度', () => {
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(12345)).toBe('1.2 万')
    expect(formatCompact(123456789)).toBe('1.2 亿')
    expect(formatCompact(10000)).toBe('1 万')
  })

  it('formatCacheHit：命中数 + 占入 token 百分比；无命中/无入 token 只显示数字', () => {
    expect(formatCacheHit({ cachedTokens: 400, promptTokens: 1000 })).toBe('400 (40%)')
    expect(formatCacheHit({ cachedTokens: 400, promptTokens: 0 })).toBe('400')
    expect(formatCacheHit({ cachedTokens: 0, promptTokens: 1000 })).toBe('0')
    expect(formatCacheHit({})).toBe('0')
  })

  it('formatPercent：分母为 0 返回 -，不显示 0% 误导', () => {
    expect(formatPercent(1, 4)).toBe('25%')
    expect(formatPercent(0, 0)).toBe('-')
    expect(formatPercent(3, 0)).toBe('-')
  })
})
