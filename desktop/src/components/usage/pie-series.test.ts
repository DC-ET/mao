import { describe, expect, it } from 'vitest'
import { buildPieSlices, PIE_LABEL_MIN_PERCENT, PIE_OTHER_LABEL, pieSlicePercents } from './pie-series'

describe('pie-series', () => {
  it('空数据返回空数组，图表走空态', () => {
    expect(buildPieSlices([])).toEqual([])
  })

  it('按调用次数降序出片，全量时不出「其他」', () => {
    const slices = buildPieSlices([
      { name: 'B', callCount: 5, totalTokens: 50 },
      { name: 'A', callCount: 10, totalTokens: 100 },
      { name: 'C', callCount: 1, totalTokens: 10 },
    ])
    expect(slices.map((s) => s.name)).toEqual(['A', 'B', 'C'])
    expect(slices.map((s) => s.value)).toEqual([10, 5, 1])
    expect(slices[0]).toEqual({ name: 'A', value: 10, calls: 10, tokens: 100, cost: undefined })
  })

  it('超过上限的尾部合并为「其他」，数值合计', () => {
    const slices = buildPieSlices([
      { name: 'A', callCount: 10, totalTokens: 100, cost: 1 },
      { name: 'B', callCount: 8, totalTokens: 80 },
      { name: 'C', callCount: 6, totalTokens: 60 },
      { name: 'D', callCount: 4, totalTokens: 40 },
      { name: 'E', callCount: 2, totalTokens: 20 },
    ], 3)
    expect(slices.map((s) => s.name)).toEqual(['A', 'B', 'C', PIE_OTHER_LABEL])
    expect(slices[3]).toEqual({ name: PIE_OTHER_LABEL, value: 6, calls: 6, tokens: 60, cost: undefined })
  })

  it('「其他」合计成本：有成本的行才累加，全无成本则为 undefined', () => {
    const slices = buildPieSlices([
      { name: 'A', callCount: 10, totalTokens: 100, cost: 1.5 },
      { name: 'B', callCount: 8, totalTokens: 80, cost: 0.5 },
      { name: 'C', callCount: 6, totalTokens: 60 },
    ], 2)
    expect(slices[2]).toEqual({ name: PIE_OTHER_LABEL, value: 6, calls: 6, tokens: 60, cost: undefined })

    const withCost = buildPieSlices([
      { name: 'A', callCount: 10, totalTokens: 100, cost: 1.5 },
      { name: 'B', callCount: 8, totalTokens: 80, cost: 0.5 },
      { name: 'C', callCount: 6, totalTokens: 60, cost: 2 },
    ], 2)
    expect(withCost[2].cost).toBe(2)
  })

  it('调用数为 0 的行不进饼图', () => {
    const slices = buildPieSlices([
      { name: 'A', callCount: 3, totalTokens: 30 },
      { name: 'B', callCount: 0, totalTokens: 0 },
    ])
    expect(slices.map((s) => s.name)).toEqual(['A'])
  })

  it('pieSlicePercents：按调用数占比，与切片等长；全零时为 0', () => {
    const slices = buildPieSlices([
      { name: 'A', callCount: 34, totalTokens: 340 },
      { name: 'B', callCount: 28, totalTokens: 280 },
      { name: 'C', callCount: 1, totalTokens: 10 },
    ])
    const percents = pieSlicePercents(slices)
    expect(percents).toHaveLength(3)
    expect(percents[0]).toBeCloseTo(53.97, 2)
    expect(percents[1]).toBeCloseTo(44.44, 2)
    expect(percents[2]).toBeCloseTo(1.59, 2)
    // 只有前两片够门槛，会在环上贴百分比；细片只进图例与 tooltip
    expect(percents.filter((p) => p >= PIE_LABEL_MIN_PERCENT)).toHaveLength(2)

    expect(pieSlicePercents([])).toEqual([])
  })
})
