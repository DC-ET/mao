import type { AnalyticsPeriod, AnalyticsQuery, PeriodValue } from '../types'

export const PERIOD_OPTIONS = [
  { label: '今日', value: 'today' as const },
  { label: '昨日', value: 'yesterday' as const },
  { label: '3 天', value: 3 },
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 }
]

export function resolvePeriod(value: PeriodValue): AnalyticsPeriod {
  if (value === 'today') return { days: 1, endOffset: 0 }
  if (value === 'yesterday') return { days: 1, endOffset: 1 }
  return { days: Number(value), endOffset: 0 }
}

export function periodToQueryValue(value: PeriodValue): string {
  return String(value)
}

export function periodFromQueryValue(raw: unknown): PeriodValue {
  if (raw === 'today' || raw === 'yesterday') return raw
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  return 'today'
}

export function buildAnalyticsQuery(period: PeriodValue, limit?: number): AnalyticsQuery {
  const base = resolvePeriod(period)
  return limit != null ? { ...base, limit } : base
}

/** 缓存键含周期，换周期自然 miss；force 由调用方先 invalidate。 */
export function periodKey(scope: string, query: AnalyticsQuery): string {
  return `${scope}|${query.days}|${query.endOffset}|${query.limit ?? ''}|${query.modelId ?? ''}|${query.excludeConnectivity ?? ''}`
}
