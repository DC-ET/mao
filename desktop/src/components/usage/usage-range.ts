import type { UsageDateRange, UsageRange } from '../../api'

/** 统计周期分组：日历周期在前，滚动窗口在后，自定义区间单独一段（见 PeriodPicker 弹层）。 */
export const PERIOD_GROUPS: Array<{ label: string; options: Array<{ label: string; value: UsageRange }> }> = [
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
      { label: '近 7 天', value: 'last7' },
      { label: '近 30 天', value: 'last30' }
    ]
  }
]

/** 扁平选项表：按值反查中文标签（自定义不在其中，见 CUSTOM_PERIOD_LABEL）。 */
export const PERIOD_OPTIONS: Array<{ label: string; value: UsageRange }> = PERIOD_GROUPS.flatMap(
  (group) => group.options
)

/** 自定义周期文案：弹层底部入口按钮与触发器回显共用。 */
export const CUSTOM_PERIOD_LABEL = '自定义'

/** 自定义区间最长跨度（天）：与管理后台同口径，超长区间趋势图不可读、后端还要补全部日桶。 */
export const MAX_CUSTOM_DAYS = 90

/** 自定义区间最早可回溯到多少天前（与管理后台 endOffset 上限同口径）。 */
export const MAX_CUSTOM_LOOKBACK_DAYS = 365

/** 周期 → 触发器/面板文案。 */
export function periodLabel(range: UsageRange): string {
  if (range === 'custom') return CUSTOM_PERIOD_LABEL
  // 白名单外的值后端会回落 last30，标签同口径
  return PERIOD_OPTIONS.find((option) => option.value === range)?.label ?? '近 30 天'
}

// ---- 日历口径（Asia/Shanghai，周一为一周起点）：与后端 rangeWindow 保持同一套规则 ----

const SHANGHAI_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** 北京时间今天（YYYY-MM-DD）：后端所有周期窗口都按 Asia/Shanghai 日历日闭合，浏览器时区不能把窗口算偏一天。 */
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

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !YMD_PATTERN.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  // 往返比较：Date.parse 会把 2026-02-29 这类不存在的日期顺延成 3 月 1（V8 不报错）
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** 日历日 → 本地零点 Date：el-date-picker 对 'YYYY-MM-DD' 的解释，禁用规则按同一把尺子比。 */
export function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 自定义周期默认区间：最近 7 天（与「近 7 天」同口径），切过去立刻有数据可看。 */
export function defaultCustomDateRange(now: Date = new Date()): UsageDateRange {
  const today = todayYmd(now)
  return { startDate: addDaysYmd(today, -6), endDate: today }
}

/**
 * 请求参数里的自定义区间：只在 range=custom 时下发。
 * 其他周期必须返回 undefined——多带起止日会干扰后端的窗口计算，
 * 而且每个周期切换都会白送两个 query 参数。
 */
export function usageDateRange(
  range: UsageRange,
  custom: UsageDateRange | undefined
): UsageDateRange | undefined {
  if (range !== 'custom') return undefined
  // 两个日期都由日期选择器保证非空；这里兜底防半成品状态（EP 允许中途只有一端）
  if (!custom?.startDate || !custom?.endDate) return undefined
  return { startDate: custom.startDate, endDate: custom.endDate }
}

// ---- 自定义区间合法性：两个日期选择器的禁用规则互相对应，从源头禁掉非法区间 ----

export interface CustomRangeBounds {
  /** 最早可选日（本地零点）：早于它的日期会被后端 endOffset 上限 clamp 成另一个窗口 */
  min: Date
  /** 最晚可选日（本地零点）：晚于今天没有数据 */
  max: Date
}

export function customRangeBounds(today: string = todayYmd()): CustomRangeBounds {
  return {
    min: ymdToLocalDate(addDaysYmd(today, -MAX_CUSTOM_LOOKBACK_DAYS)),
    max: ymdToLocalDate(today)
  }
}

/**
 * 自定义区间某一端是否置灰：出边界、start > end、跨度超过 MAX_CUSTOM_DAYS 都选不出来。
 * 两端规则互相对应（起点看终点、终点看起点），用户在日历上就凑不出非法区间。
 */
export function isCustomDateDisabled(
  date: Date,
  side: 'start' | 'end',
  range: { start: string; end: string },
  bounds: CustomRangeBounds
): boolean {
  const time = date.getTime()
  if (time < bounds.min.getTime() || time > bounds.max.getTime()) return true
  const other = ymdToLocalDate(side === 'start' ? range.end : range.start).getTime()
  const span = MAX_CUSTOM_DAYS - 1
  return side === 'start'
    ? time > other || time < ymdToLocalDate(addDaysYmd(range.end, -span)).getTime()
    : time < other || time > ymdToLocalDate(addDaysYmd(range.start, span)).getTime()
}

/**
 * 收敛自定义区间：起止颠倒时交换，跨度超上限时保留终点、把起点拉到最长跨度处。
 * 禁用规则挡不住外部（旧版本写入 / 手改）带进来的超长区间，下发前兜底一次。
 */
export function normalizeCustomRange(start: string, end: string): UsageDateRange | null {
  if (!isValidYmd(start) || !isValidYmd(end)) return null
  const ordered = start <= end ? { start, end } : { start: end, end: start }
  const span = daysBetweenYmd(ordered.start, ordered.end) + 1
  return span > MAX_CUSTOM_DAYS
    ? { startDate: addDaysYmd(ordered.end, -(MAX_CUSTOM_DAYS - 1)), endDate: ordered.end }
    : { startDate: ordered.start, endDate: ordered.end }
}
