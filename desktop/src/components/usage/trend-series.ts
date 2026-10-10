import type { UsageTrendBucket } from '../../api'
import { pickTokenUnit, type TokenUnit } from '../../utils/usageFormat'

export interface TrendSeries {
  /** 轴标签：day 桶为 MM-DD，hour 桶为 HH:00（今日/昨日的单日视图） */
  labels: string[]
  tokens: number[]
  costs: number[]
  calls: number[]
  fails: number[]
  totalTokens: number
  totalCost: number
  totalCalls: number
  /** Token 纵轴统一单位：按窗口峰值选取，坐标轴读数形如 50M / 100M / 1B */
  tokenUnit: TokenUnit | null
}

/**
 * bucket 键 → 轴标签。day 桶（YYYY-MM-DD）取日期后缀 MM-DD；
 * hour 桶（YYYY-MM-DD HH:00）只用于单日窗口（今日/昨日），取 HH:00 即可。
 */
export function trendBucketLabel(bucket: string, granularity: 'day' | 'hour' = 'day'): string {
  return granularity === 'hour' ? bucket.slice(11) : bucket.slice(5)
}

/** 趋势桶序列 → 图表数据与窗口合计（后端已补零，序列连续无缺口）。 */
export function buildTrendSeries(buckets: UsageTrendBucket[], granularity: 'day' | 'hour' = 'day'): TrendSeries {
  const series: TrendSeries = {
    labels: [],
    tokens: [],
    costs: [],
    calls: [],
    fails: [],
    totalTokens: 0,
    totalCost: 0,
    totalCalls: 0,
    tokenUnit: null,
  };
  let peak = 0;
  for (const b of buckets) {
    series.labels.push(trendBucketLabel(b.bucket, granularity));
    series.tokens.push(b.totalTokens);
    series.costs.push(b.cost);
    series.calls.push(b.callCount);
    series.fails.push(b.failCount);
    series.totalTokens += b.totalTokens;
    series.totalCost += b.cost;
    series.totalCalls += b.callCount;
    if (b.totalTokens > peak) peak = b.totalTokens;
  }
  series.tokenUnit = pickTokenUnit(peak);
  return series;
}
