import { describe, expect, it } from 'vitest'
import { formatCacheHit, formatCost, formatNumber, formatPercent, formatPercentValue, formatToken, formatTokenWithUnit, pickTokenUnit } from './usageFormat'

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

  it('formatToken：小于 1000 原样，千位以上按 K/M/B/T 折算（固定两位小数）', () => {
    expect(formatToken(0)).toBe('0')
    expect(formatToken(999)).toBe('999')
    expect(formatToken(1000)).toBe('1.00K')
    expect(formatToken(1500)).toBe('1.50K')
    expect(formatToken(12345)).toBe('12.35K')
    expect(formatToken(667577705)).toBe('667.58M')
    expect(formatToken(1e9)).toBe('1.00B')
    expect(formatToken(1.4e9)).toBe('1.40B')
    expect(formatToken(2.5e12)).toBe('2.50T')
    expect(formatToken(null)).toBe('0')
    expect(formatToken(undefined)).toBe('0')
    expect(formatToken(Number.NaN)).toBe('0')
  })

  it('formatToken：贴近上级单位上限时进位，不出现 1000K 读数', () => {
    expect(formatToken(999999)).toBe('1.00M')
    expect(formatToken(999949)).toBe('999.95K')
  })

  it('pickTokenUnit/formatTokenWithUnit：纵轴按统一单位读数（两位小数）', () => {
    const unit = pickTokenUnit(250000000)
    expect(unit?.label).toBe('M')
    expect(pickTokenUnit(800)).toBeNull()
    expect(formatTokenWithUnit(0, unit)).toBe('0')
    expect(formatTokenWithUnit(50000000, unit)).toBe('50.00M')
    expect(formatTokenWithUnit(100000000, unit)).toBe('100.00M')
    expect(formatTokenWithUnit(250000000, unit)).toBe('250.00M')
    expect(formatTokenWithUnit(800, null)).toBe('800')
  })

  it('formatCacheHit：命中数 + 占入 token 百分比；无命中/无入 token 只显示数字', () => {
    expect(formatCacheHit({ cachedTokens: 400, promptTokens: 1000 })).toBe('400 (40%)')
    expect(formatCacheHit({ cachedTokens: 400, promptTokens: 0 })).toBe('400')
    expect(formatCacheHit({ cachedTokens: 0, promptTokens: 1000 })).toBe('0')
    expect(formatCacheHit({})).toBe('0')
    // 命中数同样按 K/M 折算
    expect(formatCacheHit({ cachedTokens: 1500000, promptTokens: 2500000 })).toBe('1.50M (60%)')
  })

  it('formatPercent：分母为 0 返回 -，不显示 0% 误导', () => {
    expect(formatPercent(1, 4)).toBe('25%')
    expect(formatPercent(0, 0)).toBe('-')
    expect(formatPercent(3, 0)).toBe('-')
  })

  it('formatPercentValue：细片占比不四舍五入成 0%，也不拖长小数', () => {
    expect(formatPercentValue(0.4)).toBe('<1%')
    expect(formatPercentValue(1.4)).toBe('1.4%')
    expect(formatPercentValue(9.94)).toBe('9.9%')
    expect(formatPercentValue(9.96)).toBe('10%')
    expect(formatPercentValue(34.2)).toBe('34%')
    expect(formatPercentValue(0)).toBe('0%')
    expect(formatPercentValue(Number.NaN)).toBe('0%')
  })
})
