import { describe, expect, it } from 'vitest'
import type { UsageTrendBucket } from '../../api'
import { buildTrendSeries, trendBucketLabel } from './trend-series'

function bucket(partial: Partial<UsageTrendBucket>): UsageTrendBucket {
  return { bucket: '2026-10-10', callCount: 0, failCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, ...partial }
}

describe('trend-series', () => {
  it('trendBucketLabel：day 桶截到 MM-DD，hour 桶只保留时:分', () => {
    expect(trendBucketLabel('2026-10-10')).toBe('10-10')
    expect(trendBucketLabel('2026-10-10', 'day')).toBe('10-10')
    expect(trendBucketLabel('2026-10-10 12:00', 'hour')).toBe('12:00')
  })

  it('buildTrendSeries：按桶序产出标签与指标序列，并累计窗口合计', () => {
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
    expect(series.hitRates).toEqual([null, null])
    expect(series.totalCalls).toBe(0)

    const empty = buildTrendSeries([])
    expect(empty.labels).toEqual([])
    expect(empty.hitRates).toEqual([])
    expect(empty.totalTokens).toBe(0)
  })

  it('buildTrendSeries：hour 粒度标签走 HH:00，tokenUnit 按窗口峰值选取', () => {
    const series = buildTrendSeries([
      bucket({ bucket: '2026-10-10 00:00', totalTokens: 25_000_000 }),
      bucket({ bucket: '2026-10-10 01:00', totalTokens: 0 }),
    ], 'hour')
    expect(series.labels).toEqual(['00:00', '01:00'])
    expect(series.tokenUnit?.label).toBe('M')

    const small = buildTrendSeries([bucket({ bucket: '2026-10-10', totalTokens: 800 })])
    expect(small.tokenUnit).toBeNull()
  })

  it('buildTrendSeries：hitRates 按 promptTokens 算百分比，无入 Token 的桶为 null', () => {
    const series = buildTrendSeries([
      bucket({ bucket: '2026-10-08', callCount: 1, promptTokens: 1000, cachedTokens: 250 }),
      bucket({ bucket: '2026-10-09', callCount: 1, promptTokens: 3, cachedTokens: 1 }),
      bucket({ bucket: '2026-10-10' }),
    ])
    expect(series.hitRates).toEqual([25, 33.3, null])
  })
})
