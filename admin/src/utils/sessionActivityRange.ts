/**
 * 管理后台会话列表「活跃时间」筛选（技术方案 2026-11-06「会话列表关键词搜索超时」）。
 *
 * 语义：会话按 last_activity_at、关键词消息按 created_at 同窗过滤；默认最近 7 天，
 * 后端在缺省参数时同样兜底 7 天（见 backend-ts session/message-search.ts resolveActivityWindow）。
 * 预设档位只把档位名发给后端，由后端按 Asia/Shanghai 日历计算窗口，避免浏览器时区造成边界漂移。
 */
export type ActivityRangeValue = '1D' | '3D' | '7D' | '30D' | '90D' | 'CUSTOM' | 'ALL'

export const ACTIVITY_RANGE_DEFAULT: ActivityRangeValue = '7D'

export const ACTIVITY_RANGE_OPTIONS: Array<{ value: ActivityRangeValue; label: string }> = [
  { value: '1D', label: '最近 1 天' },
  { value: '3D', label: '最近 3 天' },
  { value: '7D', label: '最近 7 天' },
  { value: '30D', label: '最近 30 天' },
  { value: '90D', label: '最近 90 天' },
  { value: 'CUSTOM', label: '自定义' },
  { value: 'ALL', label: '全部时间' }
]

/** 默认档位对应的天数，用于「自定义」切过来时的初始区间。 */
const DEFAULT_ACTIVITY_DAYS = 7

export function isActivityRangeValue(value: string): value is ActivityRangeValue {
  return ACTIVITY_RANGE_OPTIONS.some((option) => option.value === value)
}

/** 上海时区当天 YYYY-MM-DD（与后端窗口口径一致）。 */
export function shanghaiToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** YYYY-MM-DD 按日历加减天数（不做时区换算）。 */
export function shiftDate(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number)
  const utc = new Date(Date.UTC(year!, month! - 1, day! + days))
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(utc.getUTCDate()).padStart(2, '0')
  return `${utc.getUTCFullYear()}-${mm}-${dd}`
}

/** 「自定义」档位的初始区间：最近 N 天（含今天）。 */
export function defaultCustomRange(now: Date = new Date()): [string, string] {
  const today = shanghaiToday(now)
  return [shiftDate(today, -(DEFAULT_ACTIVITY_DAYS - 1)), today]
}

/**
 * 把筛选状态翻译成请求参数：
 * - 预设档位 → `range=1D|3D|7D|30D|90D`（窗口由后端计算）；
 * - 全部时间 → `range=ALL`（后端不做时间过滤）；
 * - 自定义 → `dateFrom` / `dateTo`（都为空时不发，交后端默认兜底）。
 */
export function activityRangeParams(
  range: string,
  customRange: [string, string] | null
): Record<string, string> {
  if (range === 'ALL') return { range: 'ALL' }
  if (range === 'CUSTOM') {
    const params: Record<string, string> = {}
    if (customRange?.[0]) params.dateFrom = customRange[0]
    if (customRange?.[1]) params.dateTo = customRange[1]
    return params
  }
  return { range: isActivityRangeValue(range) ? range : ACTIVITY_RANGE_DEFAULT }
}
