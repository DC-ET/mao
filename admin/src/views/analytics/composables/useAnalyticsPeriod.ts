import type { AnalyticsQuery, CustomPeriodRange, PeriodValue } from '../types'

export interface PeriodOption {
  label: string
  value: PeriodValue
}

/** 周期选择器分组：日历周期在前、滚动窗口居中，自定义区间单独一段（见 PeriodPicker）。 */
export const PERIOD_GROUPS: Array<{ label: string; options: PeriodOption[] }> = [
  {
    label: '日历周期',
    options: [
      { label: '今日', value: 'today' },
      { label: '昨日', value: 'yesterday' },
      { label: '本周', value: 'week' },
      { label: '上周', value: 'lastWeek' },
      { label: '本月', value: 'month' },
      { label: '上月', value: 'lastMonth' }
    ]
  },
  {
    label: '最近',
    options: [
      { label: '近 3 天', value: 3 },
      { label: '近 7 天', value: 7 },
      { label: '近 30 天', value: 30 },
      { label: '近 90 天', value: 90 }
    ]
  }
]

/** 扁平选项表：按值反查中文标签（自定义不在其中，见 CUSTOM_PERIOD_LABEL）。 */
export const PERIOD_OPTIONS: PeriodOption[] = PERIOD_GROUPS.flatMap((group) => group.options)

export const CUSTOM_PERIOD_LABEL = '自定义'

/** 自定义区间跨度上限：与后端 days clamp 1–90 对齐，超出部分由选择器禁用。 */
export const MAX_CUSTOM_DAYS = 90

/** 自定义区间可回溯上限：与后端 endOffset clamp 0–365 对齐（含 90 天跨度）。 */
export const MAX_CUSTOM_LOOKBACK_DAYS = 365

export function periodLabel(value: PeriodValue): string {
  if (value === 'custom') return CUSTOM_PERIOD_LABEL
  return PERIOD_OPTIONS.find((option) => option.value === value)?.label ?? `近 ${value} 天`
}

/**
 * 工具栏周期摘要的前缀标签：日历周期与自定义的语义光看起止日看不出来（「10-26 ~ 10-29」
 * 不像「本周」），今日/昨日与滚动窗口则不必重复。
 */
export function periodPrefixLabel(value: PeriodValue): string {
  return value === 'week' || value === 'lastWeek' || value === 'month' || value === 'lastMonth' || value === 'custom'
    ? periodLabel(value)
    : ''
}

// ---- 日历口径（Asia/Shanghai，周一为一周起点）与后端 resolveAnalyticsRange 保持同一套规则 ----

const SHANGHAI_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** 北京时间今天（YYYY-MM-DD）：浏览器时区不能把窗口算偏一天，故显式按上海时区取日。 */
export function todayYmd(now: Date = new Date()): string {
  const parts = SHANGHAI_YMD_FORMATTER.formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** b − a 的日历天数。 */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number)
  const [ty, tm, td] = toYmd.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** 本周一（周一为一周起点）。 */
function weekStartYmd(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
  return addDaysYmd(today, dow === 0 ? -6 : 1 - dow)
}

/** 上月闭区间（上月末 = 本月初退一天）。 */
function lastMonthRangeYmd(today: string): { start: string; end: string } {
  const [y, m] = today.split('-').map(Number)
  return {
    start: `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`,
    end: addDaysYmd(`${today.slice(0, 7)}-01`, -1)
  }
}

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isValidYmd(value: unknown): value is string {
  return typeof value === 'string' && YMD_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

/**
 * 周期覆盖的日历天数（规则同后端 resolveAnalyticsRange）：
 * 只用于趋势粒度默认值与数据未到位时的文案，真实窗口一律由后端按 range 解析。
 * 自定义区间缺省/非法时按最长窗口兜底——天粒度安全，小时粒度会把长窗口炸成几百个桶。
 */
export function periodDays(
  value: PeriodValue,
  custom?: CustomPeriodRange,
  today: string = todayYmd()
): number {
  switch (value) {
    case 'today':
    case 'yesterday':
      return 1
    case 'week':
      return daysBetweenYmd(weekStartYmd(today), today) + 1
    case 'lastWeek':
      return 7
    case 'month':
      return Number(today.slice(8, 10))
    case 'lastMonth': {
      const { start, end } = lastMonthRangeYmd(today)
      return daysBetweenYmd(start, end) + 1
    }
    case 'custom': {
      if (custom && isValidYmd(custom.start) && isValidYmd(custom.end) && custom.start <= custom.end) {
        return daysBetweenYmd(custom.start, custom.end) + 1
      }
      return MAX_CUSTOM_DAYS
    }
    default:
      return value
  }
}

/** 数据未到位时的周期文案（有响应后统一用后端返回的真实起止日）。 */
export function periodFallbackText(value: PeriodValue, custom?: CustomPeriodRange): string {
  switch (value) {
    case 'today':
      return '今日 00:00 起'
    case 'yesterday':
      return '昨日 00:00 起'
    case 'week':
      return '本周（周一至今）'
    case 'lastWeek':
      return '上周（周一至周日）'
    case 'month':
      return '本月（1 日至今）'
    case 'lastMonth':
      return '上月（整月）'
    case 'custom':
      return custom ? `${custom.start} ~ ${custom.end}` : `${CUSTOM_PERIOD_LABEL}区间`
    default:
      return `近 ${value} 天`
  }
}

export type TrendGrain = 'hour' | 'day'

/** 统计周期不足 7 天时默认按小时，否则按天。 */
export function defaultTrendGrain(
  value: PeriodValue,
  custom?: CustomPeriodRange,
  today?: string
): TrendGrain {
  return periodDays(value, custom, today) < 7 ? 'hour' : 'day'
}

export function normalizeTrendGrain(
  raw: unknown,
  value: PeriodValue,
  custom?: CustomPeriodRange
): TrendGrain {
  return raw === 'hour' || raw === 'day' ? raw : defaultTrendGrain(value, custom)
}

/** 自定义区间默认值：最近 7 天（与「近 7 天」同口径），切过去立刻有数据可看。 */
export function defaultCustomRange(today: string = todayYmd()): CustomPeriodRange {
  return { start: addDaysYmd(today, -6), end: today }
}

/** URL 上的自定义区间：两端都合法才认，否则回落默认区间（防手改链接）。 */
export function customRangeFromQuery(start: unknown, end: unknown): CustomPeriodRange {
  if (isValidYmd(start) && isValidYmd(end) && start <= end) return { start, end }
  return defaultCustomRange()
}

export function periodToQueryValue(value: PeriodValue): string {
  return String(value)
}

export function periodFromQueryValue(raw: unknown, start?: unknown, end?: unknown): PeriodValue {
  if (
    raw === 'today' ||
    raw === 'yesterday' ||
    raw === 'week' ||
    raw === 'lastWeek' ||
    raw === 'month' ||
    raw === 'lastMonth'
  ) {
    return raw
  }
  // 自定义必须带合法起止日，否则视为无效周期回落今日
  if (raw === 'custom' && isValidYmd(start) && isValidYmd(end) && start <= end) return 'custom'
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  return 'today'
}

export function buildAnalyticsQuery(
  value: PeriodValue,
  custom?: CustomPeriodRange,
  limit?: number
): AnalyticsQuery {
  const base: AnalyticsQuery = { range: value }
  // 只有自定义周期才带起止日：其他周期多带会干扰后端窗口解析
  if (value === 'custom' && custom && isValidYmd(custom.start) && isValidYmd(custom.end)) {
    base.start = custom.start
    base.end = custom.end
  }
  return limit != null ? { ...base, limit } : base
}

/** 缓存键含周期语义；换周期自然 miss，force 由调用方先 invalidate。
 * scene / scope 也进键：运行轨迹榜换口径或换维度必须重新拉取。 */
export function periodKey(scope: string, query: AnalyticsQuery): string {
  return `${scope}|${query.range}|${query.start ?? ''}|${query.end ?? ''}|${query.limit ?? ''}|${query.modelId ?? ''}|${query.excludeConnectivity ?? ''}|${query.granularity ?? ''}|${query.scene ?? ''}|${query.scope ?? ''}`
}
