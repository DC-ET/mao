/**
 * 管理后台用量分析的统计周期入参。
 *
 * 管理后台的周期选择器除滚动窗口（近 N 天）外还提供日历周期（本周 / 上周 / 本月 / 上月）
 * 与自定义区间；本模块把语义周期解析成既有的 (days, endOffset) 窗口约定，
 * 下游 resolveWindows 无需感知周期种类。口径与 resolveWindows 一致：
 * Asia/Shanghai 日历日、周一为一周起点、闭区间。
 */
import { addDaysYmd, shanghaiYmd } from '../common/json.js';

/** 语义统计周期；滚动窗口仍由调用方直接给 days。 */
export type AnalyticsRange =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'lastWeek'
  | 'month'
  | 'lastMonth'
  | 'custom';

const ANALYTICS_RANGES: AnalyticsRange[] = [
  'today',
  'yesterday',
  'week',
  'lastWeek',
  'month',
  'lastMonth',
  'custom',
];

/** range 入参白名单：非法/缺省返回 null，调用方回落 days/endOffset（mao-cli 兼容口径）。 */
export function parseAnalyticsRange(value: unknown): AnalyticsRange | null {
  return typeof value === 'string' && (ANALYTICS_RANGES as string[]).includes(value)
    ? (value as AnalyticsRange)
    : null;
}

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** 本周一（周一为一周起点）。 */
function weekStartYmd(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDaysYmd(today, dow === 0 ? -6 : 1 - dow);
}

/** 上月闭区间：本月初退一天得上月末，再取上一个月的 1 号。 */
function lastMonthRangeYmd(today: string): { start: string; end: string } {
  const [y, m] = today.split('-').map(Number);
  return {
    start: `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`,
    end: addDaysYmd(`${today.slice(0, 7)}-01`, -1),
  };
}

export interface AnalyticsRangeWindow {
  days: number;
  endOffset: number;
}

/**
 * 语义周期 → 窗口天数 + 结束日前移天数。today 可注入便于测试，缺省取北京时间今天。
 * custom 的起止日缺省/非法/倒挂时返回 null，由调用方回落默认窗口。
 */
export function resolveAnalyticsRange(
  range: AnalyticsRange,
  dateRange?: { start?: string; end?: string },
  today: string = shanghaiYmd(),
): AnalyticsRangeWindow | null {
  switch (range) {
    case 'today':
      return { days: 1, endOffset: 0 };
    case 'yesterday':
      return { days: 1, endOffset: 1 };
    case 'week':
      return { days: daysBetween(weekStartYmd(today), today) + 1, endOffset: 0 };
    case 'lastWeek':
      return { days: 7, endOffset: daysBetween(addDaysYmd(weekStartYmd(today), -7), today) };
    case 'month':
      return { days: Number(today.slice(8, 10)), endOffset: 0 };
    case 'lastMonth': {
      const { start, end } = lastMonthRangeYmd(today);
      return { days: daysBetween(start, end) + 1, endOffset: daysBetween(end, today) };
    }
    case 'custom': {
      const start = dateRange?.start;
      const end = dateRange?.end;
      if (!start || !end || !YMD_PATTERN.test(start) || !YMD_PATTERN.test(end)) return null;
      if (daysBetween(start, end) < 0) return null;
      return { days: daysBetween(start, end) + 1, endOffset: daysBetween(end, today) };
    }
  }
}
