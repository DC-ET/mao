import type { UsageTrendBucket } from '../../api'

export interface TrendSeries {
  /** 轴标签：day 桶为 MM-DD，hour 桶为 MM-DD HH:00 */
  labels: string[]
  tokens: number[]
  costs: number[]
  calls: number[]
  fails: number[]
  totalTokens: number
  totalCost: number
  totalCalls: number
}

/**
 * bucket 键 → 轴标签。day 桶（YYYY-MM-DD）与 hour 桶（YYYY-MM-DD HH:00）
 * 都只要日期后缀，直接 slice(5) 即可，无需分支。
 */
export function trendBucketLabel(bucket: string): string {
  return bucket.slice(5)
}

/** 趋势桶序列 → 图表数据与窗口合计（后端已补零，序列连续无缺口）。 */
export function buildTrendSeries(buckets: UsageTrendBucket[]): TrendSeries {
  const series: TrendSeries = {
    labels: [],
    tokens: [],
    costs: [],
    calls: [],
    fails: [],
    totalTokens: 0,
    totalCost: 0,
    totalCalls: 0,
  };
  for (const b of buckets) {
    series.labels.push(trendBucketLabel(b.bucket))
    series.tokens.push(b.totalTokens)
    series.costs.push(b.cost)
    series.calls.push(b.callCount)
    series.fails.push(b.failCount)
    series.totalTokens += b.totalTokens
    series.totalCost += b.cost
    series.totalCalls += b.callCount
  }
  return series
}
