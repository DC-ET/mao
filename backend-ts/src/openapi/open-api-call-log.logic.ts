import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

/** 完整请求体 UTF-8 字节上限（MEDIUMTEXT 远大于此，避免单行过大）。 */
export const FULL_BODY_MAX_BYTES = 64 * 1024;
const ERROR_SUMMARY_MAX = 512;
const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|credential/i;

export type OpenCallOutcome = 'pending' | 'queued' | 'rejected' | 'completed' | 'failed' | 'cancelled';
export type OpenCallSource = 'API' | 'WEBHOOK';

export interface LogicalRejection {
  httpStatus: number;
  errorCode: string;
  errorSummary: string;
}

/** 3041 在本路径只可能是预算拒绝（与 SHARE_NOT_FOUND 撞号，禁止按数字反查常量名）。 */
export function logicalRejection(err: unknown): LogicalRejection {
  if (err instanceof BusinessException) {
    return {
      ...mapBusinessCode(err.code),
      errorSummary: clip(err.message, ERROR_SUMMARY_MAX),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { httpStatus: 500, errorCode: 'INTERNAL_ERROR', errorSummary: clip(message, ERROR_SUMMARY_MAX) };
}

export function mapBusinessCode(code: number): { httpStatus: number; errorCode: string } {
  if (code === ErrorCode.BUDGET_EXCEEDED.code) return { httpStatus: 403, errorCode: 'BUDGET_EXCEEDED' };
  if (code === ErrorCode.FORBIDDEN.code) return { httpStatus: 403, errorCode: 'FORBIDDEN' };
  if (code === ErrorCode.TOKEN_AUTO_DISABLED.code) return { httpStatus: 403, errorCode: 'TOKEN_AUTO_DISABLED' };
  if (code === ErrorCode.PARAM_INVALID.code || code === ErrorCode.PARAM_MISSING.code) return { httpStatus: 400, errorCode: 'PARAM_INVALID' };
  if (code === ErrorCode.AGENT_NOT_FOUND.code) return { httpStatus: 404, errorCode: 'AGENT_NOT_FOUND' };
  if (code === ErrorCode.SESSION_NOT_FOUND.code) return { httpStatus: 404, errorCode: 'SESSION_NOT_FOUND' };
  if (code === ErrorCode.OPEN_HOOK_NOT_FOUND.code) return { httpStatus: 404, errorCode: 'OPEN_HOOK_NOT_FOUND' };
  if (code === ErrorCode.RATE_LIMITED.code) return { httpStatus: 429, errorCode: 'RATE_LIMITED' };
  if (code === ErrorCode.UNAUTHORIZED.code || code === 401) return { httpStatus: 401, errorCode: 'UNAUTHORIZED' };
  if (code === ErrorCode.TOKEN_INVALID.code) return { httpStatus: 401, errorCode: 'TOKEN_INVALID' };
  if (code === ErrorCode.TOKEN_EXPIRED.code) return { httpStatus: 401, errorCode: 'TOKEN_EXPIRED' };
  return { httpStatus: 500, errorCode: 'INTERNAL_ERROR' };
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function buildCallSummary(source: OpenCallSource, body: unknown): string {
  if (source === 'API') {
    const rec = body != null && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof rec.message === 'string' ? rec.message : '';
    const sessionId = typeof rec.sessionId === 'number' && Number.isInteger(rec.sessionId) ? rec.sessionId : null;
    return JSON.stringify({ messageChars: message.length, sessionId });
  }
  const raw = typeof body === 'string' ? body : '';
  let payloadKeys: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payloadKeys = Object.keys(parsed as Record<string, unknown>);
    }
  } catch { /* 非 JSON 只记长度 */ }
  return JSON.stringify({ messageChars: raw.length, payloadKeys });
}

/** 键名黑名单递归打码。敏感键的值整棵替换，不再下钻。 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : redactSensitive(child);
    }
    return out;
  }
  return value;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

export function fullBodyJson(body: unknown): string {
  const json = JSON.stringify(redactSensitive(body));
  if (Buffer.byteLength(json, 'utf8') <= FULL_BODY_MAX_BYTES) return json;
  // 超长时不能从半截字符串切开，否则落库的不是合法 JSON。改存截断标记和前缀预览。
  let preview = truncateUtf8(json, FULL_BODY_MAX_BYTES);
  let out = JSON.stringify({ truncated: true, preview });
  while (Buffer.byteLength(out, 'utf8') > FULL_BODY_MAX_BYTES && preview.length > 0) {
    preview = preview.slice(0, -1);
    out = JSON.stringify({ truncated: true, preview });
  }
  return out;
}

export function messageFromFullJson(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      const message = (parsed as { message: string }).message;
      return message.trim().length > 0 ? message : null;
    }
  } catch { /* 坏 JSON 当没有 */ }
  return null;
}

/**
 * message_queue.created_at 经 dateStrings 是 `YYYY-MM-DD HH:mm:ss` 字符串。
 * 与 run-trace 一样按本地时区解析；解析失败返回 null，调用方不得因此中断回写。
 */
export function queueWaitMsOf(createdAt: string | Date | null | undefined, now = Date.now()): number | null {
  if (createdAt == null || createdAt === '') return null;
  const epoch = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt).replace(' ', 'T'));
  if (Number.isNaN(epoch)) return null;
  return Math.max(0, now - epoch);
}

/** 最近秩分位。空样本返回 null。 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export function bucketAnomalyFlags(bucket: { total: number; completed: number; failed: number; rejected: number }): {
  successRateLow: boolean;
  rejectRateHigh: boolean;
} {
  const executed = bucket.completed + bucket.failed;
  return {
    successRateLow: bucket.total >= 10 && executed > 0 && bucket.completed / executed < 0.5,
    rejectRateHigh: bucket.total >= 10 && bucket.rejected / bucket.total >= 0.5,
  };
}

/** 今日总量 ≥ max(10, 5×前 7 天日均)。 */
export function isTrafficSpike(today: number, previousSevenDayTotal: number): boolean {
  const average = previousSevenDayTotal / 7;
  return today >= Math.max(10, 5 * average);
}

export function countsTowardAutoDisable(input: {
  source: string | null;
  tokenId: number | null;
  replayOfId: number | null;
  errorCode: string | null;
  outcome: OpenCallOutcome;
}): boolean {
  if (input.source !== 'API' || input.tokenId == null || input.replayOfId != null) return false;
  if (input.outcome !== 'failed' && input.outcome !== 'rejected' && input.outcome !== 'completed') return false;
  if (input.errorCode === 'RATE_LIMITED' || input.errorCode === 'TOKEN_AUTO_DISABLED') return false;
  return true;
}

/** 单次失败通知：429 与已停用的重复 403 不进聚合。 */
export function countsTowardFailureNotice(errorCode: string | null, outcome: OpenCallOutcome): boolean {
  if (outcome !== 'failed' && outcome !== 'rejected') return false;
  return errorCode !== 'RATE_LIMITED' && errorCode !== 'TOKEN_AUTO_DISABLED';
}

export function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildOpenApiCallCsv(rows: Array<Record<string, unknown>>): string {
  const header = ['时间', '来源', 'Token', '触发器', 'Agent', '用户', '来源 IP', 'HTTP', '结果', '受理耗时(ms)', '端到端(ms)', '错误码', '错误摘要', '会话 ID'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.createdAt,
      row.source,
      row.tokenId ?? '',
      row.triggerId ?? '',
      row.agentId ?? '',
      row.userId ?? '',
      row.sourceIp ?? '',
      row.httpStatus ?? '',
      row.outcome ?? '',
      row.durationMs ?? '',
      row.executionMs ?? '',
      row.errorCode ?? '',
      row.errorSummary ?? '',
      row.sessionId ?? '',
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export function terminalOutcome(phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'): OpenCallOutcome {
  if (phase === 'FAILED') return 'failed';
  if (phase === 'CANCELLED') return 'cancelled';
  return 'completed';
}
