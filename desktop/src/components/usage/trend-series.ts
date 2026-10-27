import type { UsageTrendBucket } from '../../api'
import { pickTokenUnit, type TokenUnit } from '../../utils/usageFormat'
import { avgThroughput } from '../../utils/throughput'

export interface TrendSeries {
  /** 轴标签：day 桶为 MM-DD，hour 桶为 HH:00（今日/昨日的单日视图） */
  labels: string[]
  tokens: number[]
  costs: number[]
  calls: number[]
  fails: number[]
  /** 取消数（用户点停止）：不计入 fails，tooltip 单列一档 */
  cancels: number[]
  /** 缓存命中率趋势（%）：桶内 promptTokens 为 0（无调用）时置 null，折线断开不画到 0 */
  hitRates: Array<number | null>
  /** 输出速度趋势（tok/s，技术方案 2026-10-27-llm-output-speed §5.2）：
   *  桶内 decodeMs 为 0（无流式调用）时置 null，折线断开 */
  tps: Array<number | null>
  totalTokens: number
  totalCost: number
  totalCalls: number
  /** 窗口平均输出速度（tok/s，加权）：Σ输出 ÷ Σ解码秒；无可解码行时为 null */
  avgTps: number | null
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
    cancels: [],
    hitRates: [],
    tps: [],
    totalTokens: 0,
    totalCost: 0,
    totalCalls: 0,
    avgTps: null,
    tokenUnit: null,
  };
  let peak = 0;
  let decodeTokens = 0;
  let decodeMs = 0;
  for (const b of buckets) {
    series.labels.push(trendBucketLabel(b.bucket, granularity));
    series.tokens.push(b.totalTokens);
    series.costs.push(b.cost);
    series.calls.push(b.callCount);
    series.fails.push(b.failCount);
    series.cancels.push(b.cancelledCount);
    series.hitRates.push(hitRate(b));
    series.tps.push(bucketTps(b));
    series.totalTokens += b.totalTokens;
    series.totalCost += b.cost;
    series.totalCalls += b.callCount;
    decodeTokens += b.decodeTokens;
    decodeMs += b.decodeMs;
    if (b.totalTokens > peak) peak = b.totalTokens;
  }
  series.avgTps = avgThroughput({ decodeTokens, decodeMs });
  series.tokenUnit = pickTokenUnit(peak);
  return series;
}

/** 桶内缓存命中率（保留 1 位小数）：无入 Token 的桶返回 null，折线断开。 */
function hitRate(b: UsageTrendBucket): number | null {
  if (b.promptTokens <= 0) return null
  return Math.round((b.cachedTokens / b.promptTokens) * 1000) / 10
}

/** 桶内输出速度（tok/s）：无可解码行（decodeMs 为 0，如全非流式）时 null，折线断开。 */
function bucketTps(b: UsageTrendBucket): number | null {
  return avgThroughput({ decodeTokens: b.decodeTokens, decodeMs: b.decodeMs })
}
