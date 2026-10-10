import type { UsageDateRange, UsageRange } from '../../api'

/** 统计周期选项：日历周期在前，滚动窗口在后，自定义区间收尾。 */
export const USAGE_PERIOD_OPTIONS: Array<{ label: string; value: UsageRange }> = [
  { label: '今日', value: 'today' },
  { label: '昨日', value: 'yesterday' },
  { label: '本周', value: 'week' },
  { label: '上周', value: 'lastWeek' },
  { label: '本月', value: 'month' },
  { label: '上月', value: 'lastMonth' },
  { label: '近 7 天', value: 'last7' },
  { label: '近 30 天', value: 'last30' },
  { label: '自定义', value: 'custom' },
]

/** 自定义周期默认区间：最近 7 天（与「近 7 天」同口径），切过去立刻有数据可看。 */
export function defaultCustomDateRange(now: Date = new Date()): UsageDateRange {
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6)
  return { startDate: fmt(start), endDate: fmt(end) }
}

/**
 * 请求参数里的自定义区间：只在 range=custom 时下发。
 * 其他周期必须返回 undefined——多带 startDate/endDate 会干扰后端的窗口计算，
 * 而且每个周期切换都会白送两个 query 参数。
 */
export function usageDateRange(
  range: UsageRange,
  custom: UsageDateRange | undefined,
): UsageDateRange | undefined {
  if (range !== 'custom') return undefined
  // 两个日期都由日期区间选择器保证非空；这里兜底防半成品状态（EP 允许中途只有一端）
  if (!custom?.startDate || !custom?.endDate) return undefined
  return { startDate: custom.startDate, endDate: custom.endDate }
}
