import { describe, expect, it } from 'vitest'
import type { UsageTrendBucket } from '../../api'
import { buildTrendSeries, trendBucketLabel } from './trend-series'

function bucket(partial: Partial<UsageTrendBucket>): UsageTrendBucket {
  return { bucket: '2026-10-10', callCount: 0, failCount: 0, totalTokens: 0, cost: 0, ...partial }
}

describe('trend-series', () => {
  it('trendBucketLabel：day 桶截到 MM-DD，hour 桶保留整点', () => {
    expect(trendBucketLabel('2026-10-10')).toBe('10-10')
    expect(trendBucketLabel('2026-10-10 12:00')).toBe('10-10 12:00')
  })

  it('buildTrendSeries：按桶序产出标签与三个指标序列，并累计窗口合计', () => {
    const series = buildTrendSeries([
      bucket({ bucket: '2026-10-08', callCount: 2, failCount: 1, totalTokens: 200, cost: 0.5 }),
      bucket({ bucket: '2026-10-09', callCount: 3, failCount: 0, totalTokens: 300, cost: 0.25 }),
    ])
    expect(series.labels).toEqual(['10-08', '10-09'])
    expect(series.tokens).toEqual([200, 300])
    expect(series.costs).toEqual([0.5, 0.25])
    expect(series.calls).toEqual([2, 3])
    expect(series.fails).toEqual([1, 0])
    expect(series.totalTokens).toBe(500)
    expect(series.totalCost).toBe(0.75)
    expect(series.totalCalls).toBe(5)
  })

  it('buildTrendSeries：后端补零后的连续序列原样映射，空序列不出轴', () => {
    const series = buildTrendSeries([
      bucket({ bucket: '2026-10-08' }),
      bucket({ bucket: '2026-10-09' }),
    ])
    expect(series.labels).toEqual(['10-08', '10-09'])
    expect(series.tokens).toEqual([0, 0])
    expect(series.totalCalls).toBe(0)

    const empty = buildTrendSeries([])
    expect(empty.labels).toEqual([])
    expect(empty.totalTokens).toBe(0)
  })
})
