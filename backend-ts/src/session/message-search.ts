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
