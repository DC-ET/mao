import { describe, expect, it } from 'vitest'
import { buildPieSlices, PIE_OTHER_LABEL } from './pie-series'

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
})
