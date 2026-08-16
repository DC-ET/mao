/**
 * Jackson-compatible JSON helpers:
 * - omit null / undefined
 * - Date → yyyy-MM-dd HH:mm:ss in Asia/Shanghai
 * - numeric IDs stay numbers
 */

const SHANGHAI = 'Asia/Shanghai';

export function formatDateTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Alias used by ported Java `format` call sites. */
export const format = formatDateTime;

export function shanghaiYmd(date: Date = new Date()): string {
  return formatDateTime(date).slice(0, 10);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function omitNull<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return formatDateTime(value);
  }
  if (Array.isArray(value)) {
    return value.map(strip).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = strip(v);
      if (next !== undefined) {
        out[k] = next;
      }
    }
    return out;
  }
  return value;
}

export function toJacksonJson(value: unknown): string {
  return JSON.stringify(omitNull(value));
}

/** MyBatis-Plus Page JSON shape used by admin/desktop. */
export interface MpPage<T> {
  records: T[];
  total: number;
  size: number;
  current: number;
  pages: number;
  orders: unknown[];
  optimizeCountSql: boolean;
  searchCount: boolean;
  optimizeJoinOfCountSql: boolean;
}

export function mpPage<T>(records: T[], total: number, current: number, size: number): MpPage<T> {
  const pages = size > 0 ? Math.ceil(total / size) : 0;
  return {
    records,
    total,
    size,
    current,
    pages,
    orders: [],
    optimizeCountSql: true,
    searchCount: true,
    optimizeJoinOfCountSql: true,
  };
}
