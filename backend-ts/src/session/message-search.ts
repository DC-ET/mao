import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

export const NGRAM_TOKEN_SIZE = 2;
export const SEARCH_KEYWORD_MAX_LENGTH = 100;
export const SEARCH_PAGE_SIZE_DEFAULT = 20;
export const SEARCH_PAGE_SIZE_MAX = 50;
export const SEARCH_OFFSET_CAP = 10000;
export const SNIPPET_CONTEXT_CHARS = 80;
export const SNIPPET_MAX_LENGTH = 200;

export type SearchPath = 'FULLTEXT' | 'LIKE';

export interface ParsedSearchTerm {
  op: '' | '+' | '-';
  text: string;
}

export interface PreparedSearch {
  path: SearchPath;
  /** FULLTEXT 为布尔短语串；LIKE 为已转义的原始关键词 */
  match: string;
  snippetTerms: string[];
}

export interface SearchListParams {
  agentId: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  sessionType: 'NORMAL' | 'SIDE_TASK' | null;
  page: number;
  size: number;
  /** 含当日 00:00:00，Asia/Shanghai 日历，不做 UTC 换算 */
  createdFrom: string | null;
  /** dateTo 次日 00:00:00，SQL 用 `<` */
  createdToExclusive: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 会话检索可命中的消息角色：CONVERSATION 只含对话双方，不受工具输出刷屏影响。 */
export const CONVERSATION_MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;

export type MessageSearchScope = 'CONVERSATION' | 'ALL';

/** 空值按 CONVERSATION（默认口径）；非法值直接报错，避免静默放宽到全部消息。 */
export function normalizeMessageScope(raw: string | null | undefined): MessageSearchScope {
  const value = raw?.trim().toUpperCase();
  if (value == null || value === '') return 'CONVERSATION';
  if (value === 'CONVERSATION' || value === 'ALL') return value;
  throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索范围不合法');
}

/** 角色过滤 SQL 片段（含前导空格）：ALL 返回空串，即不限制角色。 */
export function messageRoleClause(scope: MessageSearchScope, alias = 'm'): string {
  if (scope === 'ALL') return '';
  const roles = CONVERSATION_MESSAGE_ROLES.map((role) => `'${role}'`).join(', ');
  return ` AND ${alias}.role IN (${roles})`;
}

export function isSearchFulltextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SEARCH_FULLTEXT_ENABLED;
  if (raw == null || raw === '') return true;
  return raw === 'true' || raw === '1';
}

export function isFulltextDegradeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const errno = typeof err === 'object' && err != null && 'errno' in err ? Number((err as { errno?: unknown }).errno) : NaN;
  return errno === 188 || errno === 1064 || errno === 1191
    || /FTS query exceeds result cache limit/i.test(message)
    || /syntax error/i.test(message)
    || /Boolean full-text search/i.test(message)
    || (/fulltext/i.test(message) && /not supported|wildcard/i.test(message));
}

/** 字符数按 Unicode code point，中文一字算 1。 */
export function charLength(text: string): number {
  return [...text].length;
}

export function parseSearchTerms(raw: string): { ok: true; terms: ParsedSearchTerm[] } | { ok: false } {
  const terms: ParsedSearchTerm[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    let op: '' | '+' | '-' = '';
    if (raw[i] === '+' || raw[i] === '-') {
      const next = raw[i + 1];
      if (next == null || /\s/.test(next)) return { ok: false };
      op = raw[i] as '+' | '-';
      i++;
    }
    if (raw[i] === '"') {
      let j = i + 1;
      let text = '';
      let closed = false;
      while (j < raw.length) {
        const ch = raw[j]!;
        if (ch === '\\' && j + 1 < raw.length) {
          text += raw[j + 1];
          j += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          j++;
          break;
        }
        text += ch;
        j++;
      }
      if (!closed || text.length === 0 || text.includes('*')) return { ok: false };
      terms.push({ op, text });
      i = j;
      continue;
    }
    let j = i;
    while (j < raw.length && !/\s/.test(raw[j]!) && raw[j] !== '"') j++;
    const text = raw.slice(i, j);
    if (text.length === 0 || text.includes('*')) return { ok: false };
    terms.push({ op, text });
    i = j;
  }
  if (terms.length === 0) return { ok: false };
  return { ok: true, terms };
}

export function buildBooleanQuery(terms: ParsedSearchTerm[]): string {
  return terms.map((term) => {
    const escaped = term.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${term.op}"${escaped}"`;
  }).join(' ');
}

export function prepareMessageSearch(keyword: string, fulltextEnabled: boolean): PreparedSearch {
  const trimmed = keyword.trim();
  const like: PreparedSearch = {
    path: 'LIKE',
    match: escapeLike(trimmed),
    snippetTerms: [trimmed],
  };
  if (!fulltextEnabled) return like;
  const parsed = parseSearchTerms(trimmed);
  if (!parsed.ok) return like;
  if (parsed.terms.some((term) => charLength(term.text) < NGRAM_TOKEN_SIZE)) return like;
  return {
    path: 'FULLTEXT',
    match: buildBooleanQuery(parsed.terms),
    snippetTerms: parsed.terms.map((term) => term.text),
  };
}

function parseCalendarDate(value: string): string | null {
  const match = DATE_RE.exec(value.trim());
  if (match == null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function nextCalendarDayStart(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day! + 1));
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${mm}-${dd} 00:00:00`;
}

export function normalizeSearchListParams(input: {
  agentId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sessionType?: string | null;
  page?: number | null;
  size?: number | null;
}): SearchListParams {
  const page = input.page == null ? 1 : input.page;
  const size = input.size == null ? SEARCH_PAGE_SIZE_DEFAULT : input.size;
  if (!Number.isInteger(page) || page < 1) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '页码不合法');
  }
  if (!Number.isInteger(size) || size < 1 || size > SEARCH_PAGE_SIZE_MAX) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '分页大小不合法');
  }
  if (input.agentId != null && (!Number.isInteger(input.agentId) || input.agentId <= 0)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'Agent 不合法');
  }
  let sessionType: 'NORMAL' | 'SIDE_TASK' | null = null;
  if (input.sessionType != null && input.sessionType !== '') {
    if (input.sessionType !== 'NORMAL' && input.sessionType !== 'SIDE_TASK') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '会话类型不合法');
    }
    sessionType = input.sessionType;
  }
  const fromDay = input.dateFrom != null && input.dateFrom !== '' ? parseCalendarDate(input.dateFrom) : null;
  const toDay = input.dateTo != null && input.dateTo !== '' ? parseCalendarDate(input.dateTo) : null;
  if ((input.dateFrom != null && input.dateFrom !== '' && fromDay == null)
    || (input.dateTo != null && input.dateTo !== '' && toDay == null)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '日期不合法');
  }
  if (fromDay != null && toDay != null && fromDay > toDay) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '开始日期不能晚于结束日期');
  }
  return {
    agentId: input.agentId ?? null,
    dateFrom: fromDay,
    dateTo: toDay,
    sessionType,
    page,
    size,
    createdFrom: fromDay == null ? null : `${fromDay} 00:00:00`,
    createdToExclusive: toDay == null ? null : nextCalendarDayStart(toDay),
  };
}

/**
 * 管理端会话列表的「活跃时间」窗口（技术方案 2026-11-06「会话列表关键词搜索超时」）。
 *
 * 背景：关键词匹配此前是**全局**消息检索（`id IN (SELECT ... MATCH ...)` / 全表 LIKE），
 * 会话上的任何过滤都传不进消息子查询；message 表 68 万行、正文 1.5GB 时单次 70~80s，
 * 必然触发前端 30s 超时。现在改为「先按活跃时间筛会话，再在这些会话的窗口内消息里匹配」，
 * 扫描面随窗口收敛。
 *
 * 口径：`last_activity_at` 与消息 `created_at` 都在窗口内，按 Asia/Shanghai 日历日切分，
 * 与 message-search 既有 dateFrom/dateTo 一致（含起始日 00:00:00，结束日次日 00:00:00 开区间）。
 */
export const ACTIVITY_RANGE_ALL = 'ALL';
export const ACTIVITY_RANGE_DEFAULT = '7D';
export const ACTIVITY_RANGE_PRESET_DAYS: Readonly<Record<string, number>> = {
  '1D': 1,
  '3D': 3,
  '7D': 7,
  '30D': 30,
  '90D': 90
};

export interface ActivityWindow {
  /** 起始（含），'YYYY-MM-DD HH:MM:SS'；null = 不设下界 */
  from: string | null;
  /** 上界（不含）；null = 不设上界 */
  toExclusive: string | null;
}

/** 上海时区当天 YYYY-MM-DD（默认时间窗口径，不随宿主机时区漂移）。 */
export function shanghaiYmd(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 日历日加减（纯日历运算，不做时区换算）。 */
export function shiftCalendarDay(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day! + days));
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 解析「活跃时间」窗口：
 * - `range=ALL` → null（不限时间，管理端显式放宽，慢查询由调用方自行承担）；
 * - 传了 dateFrom/dateTo → 用显式区间（可单边）；
 * - 传了 range 预设（1D/3D/7D/30D/90D）→ 最近 N 天（含今天）；
 * - 都没传 → 默认最近 7 天，避免任何客户端直连 API 打到全表消息扫描。
 */
export function resolveActivityWindow(input: {
  range?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  now?: Date;
}): ActivityWindow | null {
  const rawRange = input.range?.trim().toUpperCase() ?? '';
  const rawFrom = input.dateFrom?.trim() ?? '';
  const rawTo = input.dateTo?.trim() ?? '';
  let presetDays: number | null = null;
  if (rawRange !== '') {
    if (rawRange === ACTIVITY_RANGE_ALL) return null;
    presetDays = ACTIVITY_RANGE_PRESET_DAYS[rawRange] ?? null;
    if (presetDays == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '时间范围不合法');
    }
  }
  if (rawFrom !== '' || rawTo !== '') {
    const fromDay = rawFrom === '' ? null : parseCalendarDate(rawFrom);
    const toDay = rawTo === '' ? null : parseCalendarDate(rawTo);
    if ((rawFrom !== '' && fromDay == null) || (rawTo !== '' && toDay == null)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '日期不合法');
    }
    if (fromDay != null && toDay != null && fromDay > toDay) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '开始日期不能晚于结束日期');
    }
    return {
      from: fromDay == null ? null : `${fromDay} 00:00:00`,
      toExclusive: toDay == null ? null : nextCalendarDayStart(toDay),
    };
  }
  const days = presetDays ?? ACTIVITY_RANGE_PRESET_DAYS[ACTIVITY_RANGE_DEFAULT]!;
  const today = shanghaiYmd(input.now ?? new Date());
  return {
    from: `${shiftCalendarDay(today, -(days - 1))} 00:00:00`,
    toExclusive: nextCalendarDayStart(today),
  };
}

export function indexOfIgnoreCase(text: string, keyword: string): number {
  return text.toLowerCase().indexOf(keyword.toLowerCase());
}

export function buildSnippet(text: string | null, keyword: string | null, extraTerms?: string[]): string | null {
  if (text == null) return null;
  const terms = (extraTerms != null && extraTerms.length > 0 ? extraTerms : [keyword ?? ''])
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) return null;
  let best = -1;
  let bestLen = 0;
  for (const term of terms) {
    const idx = indexOfIgnoreCase(text, term);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
      bestLen = term.length;
    }
  }
  if (best < 0) return null;
  let ctx = SNIPPET_CONTEXT_CHARS;
  if (bestLen + ctx * 2 > SNIPPET_MAX_LENGTH) {
    ctx = Math.max(0, Math.floor((SNIPPET_MAX_LENGTH - bestLen) / 2));
  }
  const start = Math.max(0, best - ctx);
  const end = Math.min(text.length, best + bestLen + ctx);
  const body = text.slice(start, end);
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '');
}
