import type { Db } from '../db/db.js';

import type { FeedbackReason, FeedbackSource, FeedbackStatus } from '@mao/contracts';

export type { FeedbackReason, FeedbackSource, FeedbackStatus };

export const FEEDBACK_REASONS = ['WRONG_RESULT', 'SLOW_RESPONSE', 'NOT_SOLVED', 'OTHER', 'NO_REASON'] as const satisfies readonly FeedbackReason[];

/** 点踩来源：desktop 为桌面/Web/安卓端，feishu 为飞书进度卡点踩。 */
export const FEEDBACK_SOURCES = ['desktop', 'feishu'] as const satisfies readonly FeedbackSource[];

/** 飞书点踩不选原因，固定写入该分类（后台展示为「未选择原因（飞书）」）。 */
export const FEISHU_DISLIKE_REASON: FeedbackReason = 'NO_REASON';
export const FEISHU_DISLIKE_SOURCE: FeedbackSource = 'feishu';

/**
 * 处理态：PENDING 是唯一入口态；DISMISSED 为终态，不可回退。
 * CONVERTED 是「转经验」功能（已下线）留下的存量终态：不再产生新行，
 * 但历史行仍按该值展示与筛选。
 */
export const FEEDBACK_STATUSES = ['PENDING', 'CONVERTED', 'DISMISSED'] as const satisfies readonly FeedbackStatus[];

export interface FeedbackSummaryRow {
  reason: string;
  count: number;
}

export interface FeedbackDailyRow {
  date: string;
  count: number;
}

export interface FeedbackPendingMatrixRow {
  agentId: number | null;
  agentName: string | null;
  reason: string;
  count: number;
}

export interface FeedbackDetailFilter {
  reason?: string;
  status?: string;
  agentId?: number | null;
  startDate?: string;
  endDate?: string;
  offset: number;
  limit: number;
}

export interface FeedbackDetailRow {
  id: number;
  messageId: number;
  sessionId: number;
  userId: number;
  username: string | null;
  displayName: string | null;
  agentId: number | null;
  agentName: string | null;
  reason: FeedbackReason;
  source: FeedbackSource;
  status: FeedbackStatus;
  handledBy: number | null;
  handledByName: string | null;
  handledAt: string | null;
  experienceId: number | null;
  /** 同 agent_id + reason + PENDING 的聚集条数（快照口径，不 JOIN session）。 */
  sameGroupCount: number;
  /** 被点踩消息是否仍存在：false 表示 message 行已被清理（预览显示「消息已不存在」）。 */
  messageExists: boolean;
  /** 原始消息文本（仅前 200 字符）；消息不存在时为 null。 */
  content: string | null;
  /** content 为空时用于回退预览的首个工具调用摘要；没有工具调用时为 null。 */
  toolSummary: string | null;
  /** 该消息包含的工具调用数量，用于摘要后缀（「等 N 项」）。 */
  toolCallCount: number;
  createdAt: string;
}

export class FeedbackRepository {
  constructor(private readonly db: Db) {}

  upsert(messageId: number, sessionId: number, userId: number, agentId: number | null, reason: FeedbackReason, source: FeedbackSource = 'desktop'): Promise<void> {
    return this.db.execute(
      `INSERT INTO message_feedback (message_id, session_id, user_id, agent_id, reason, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), source = VALUES(source)`,
      [messageId, sessionId, userId, agentId, reason, source],
    ).then(() => undefined);
  }

  async deleteByMessageId(messageId: number): Promise<boolean> {
    const result = await this.db.execute('DELETE FROM message_feedback WHERE message_id = ?', [messageId]);
    return result.affectedRows > 0;
  }

  existsByMessageId(messageId: number): Promise<boolean> {
    return this.db.queryOne<{ id: number }>(
      'SELECT id FROM message_feedback WHERE message_id = ? LIMIT 1',
      [messageId],
    ).then((row) => row != null);
  }

  listMessageIdsBySession(sessionId: number): Promise<number[]> {
    // 行键经 toCamelList 已转为 camelCase：message_id -> messageId
    return this.db.query<{ messageId: number }>(
      'SELECT message_id FROM message_feedback WHERE session_id = ?',
      [sessionId],
    ).then((rows) => rows.map((r) => Number(r.messageId)));
  }

  countTotal(filter: { reason?: string; status?: string; agentId?: number | null; startDate?: string; endDate?: string }): Promise<number> {
    const { where, params } = buildDetailWhere(filter);
    return this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM message_feedback f ${where}`,
      params,
    ).then((row) => row?.c ?? 0);
  }

  sumByReason(startDate?: string, endDate?: string): Promise<FeedbackSummaryRow[]> {
    const { where, params } = buildDetailWhere({ startDate, endDate });
    return this.db.query<FeedbackSummaryRow>(
      `SELECT reason, COUNT(*) AS count FROM message_feedback f ${where} GROUP BY reason`,
      params,
    );
  }

  /** 与 sumByReason / listDetails 同一套日期口径：任一侧缺省即为开区间，不再整体降级为空。 */
  sumByDay(startDate?: string, endDate?: string): Promise<FeedbackDailyRow[]> {
    const { where, params } = buildDetailWhere({ startDate, endDate });
    return this.db.query<FeedbackDailyRow>(
      `SELECT DATE_FORMAT(f.created_at, '%Y-%m-%d') AS date, COUNT(*) AS count
       FROM message_feedback f ${where}
       GROUP BY date ORDER BY date`,
      params,
    );
  }

  listDetails(filter: FeedbackDetailFilter): Promise<FeedbackDetailRow[]> {
    const { where, params } = buildDetailWhere(filter);
    const pagination: unknown[] = [...params, filter.limit, filter.offset];
    // db.query 返回行键为 camelCase（内部经 toCamelList 转换），SQL 别名用 snake 仅为可读性
    return this.db.query<Record<string, unknown>>(
      `SELECT f.id, f.message_id, f.session_id, f.user_id, f.agent_id, f.reason, f.source,
              f.status, f.handled_by, f.handled_at, f.experience_id, f.created_at,
              u.username, u.display_name,
              hu.username AS handled_by_name,
              a.name AS agent_name,
              (SELECT COUNT(*) FROM message_feedback g
                WHERE g.agent_id <=> f.agent_id AND g.reason = f.reason AND g.status = 'PENDING') AS same_group_count,
              -- message 可能已被清理：message_exists 区分「消息不存在」与「消息无文本内容」
              (m.id IS NOT NULL) AS message_exists,
              LEFT(m.content, 200) AS content_raw,
              -- 工具调用中间消息 content 为空，回退展示首个工具调用摘要（summary 优先，其次函数名）
              COALESCE(
                JSON_UNQUOTE(JSON_EXTRACT(m.tool_calls, '$[0].summary')),
                JSON_UNQUOTE(JSON_EXTRACT(m.tool_calls, '$[0].function.name'))
              ) AS tool_summary_raw,
              COALESCE(JSON_LENGTH(m.tool_calls), 0) AS tool_call_count
       FROM message_feedback f
       LEFT JOIN user u ON u.id = f.user_id
       LEFT JOIN user hu ON hu.id = f.handled_by
       LEFT JOIN agent a ON a.id = f.agent_id
       LEFT JOIN message m ON m.id = f.message_id
       ${where}
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT ? OFFSET ?`,
      pagination,
    ).then((rows) => rows.map((row) => mapDetailRow(row)));
  }

  /** 待处理数：汇总卡与明细筛选（status=PENDING）同口径。 */
  countPending(): Promise<number> {
    return this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM message_feedback f WHERE f.status = 'PENDING'`,
    ).then((row) => row?.c ?? 0);
  }

  /**
   * Agent × 原因 待处理矩阵（快照口径：按 f.agent_id 分组，不 JOIN session 取实时 Agent）。
   * agent_id 为 NULL 的行单独成组（会话无 Agent 的飞书点踩）。
   */
  countPendingGroupBy(): Promise<FeedbackPendingMatrixRow[]> {
    return this.db.query<FeedbackPendingMatrixRow>(
      `SELECT f.agent_id AS agentId, a.name AS agentName, f.reason, COUNT(*) AS count
       FROM message_feedback f
       LEFT JOIN agent a ON a.id = f.agent_id
       WHERE f.status = 'PENDING'
       GROUP BY f.agent_id, a.name, f.reason
       ORDER BY count DESC, f.agent_id, f.reason`,
    );
  }

  /** 批量忽略：CAS 只把仍为 PENDING 的行改为 DISMISSED，返回受影响行数。 */
  markDismissed(ids: number[], operatorId: number): Promise<number> {
    return this.casUpdateStatus(ids, 'DISMISSED', operatorId);
  }

  private casUpdateStatus(ids: number[], status: FeedbackStatus, operatorId: number): Promise<number> {
    return this.db.execute(
      `UPDATE message_feedback SET status = ?, handled_by = ?, handled_at = NOW(3)
       WHERE id IN (${placeholders(ids.length)}) AND status = 'PENDING'`,
      [status, operatorId, ...ids],
    ).then((result) => result.affectedRows);
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function buildDetailWhere(filter: { reason?: string; status?: string; agentId?: number | null; startDate?: string; endDate?: string }): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.reason) {
    conditions.push('f.reason = ?');
    params.push(filter.reason);
  }
  if (filter.status) {
    conditions.push('f.status = ?');
    params.push(filter.status);
  }
  // agentId 语义三态：undefined 不筛选；null 筛 agent_id IS NULL（飞书点踩无 Agent）；
  // 具体 id 走等值。`f.agent_id = NULL` 永远不成立，必须显式 IS NULL
  if (filter.agentId === null) {
    conditions.push('f.agent_id IS NULL');
  } else if (filter.agentId !== undefined) {
    conditions.push('f.agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter.startDate) {
    conditions.push('f.created_at >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate) {
    conditions.push('f.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(filter.endDate);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

function asString(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** source 兜底 desktop：列带默认值，但老库补列/异常写入可能落空串。 */
function asSource(value: unknown): FeedbackSource {
  const raw = value == null ? '' : String(value);
  return FEEDBACK_SOURCES.includes(raw as FeedbackSource) ? (raw as FeedbackSource) : 'desktop';
}

/** status 兜底 PENDING：V148 之前的存量行由列默认值回填，异常值按待处理展示。 */
function asStatus(value: unknown): FeedbackStatus {
  const raw = value == null ? '' : String(value);
  return FEEDBACK_STATUSES.includes(raw as FeedbackStatus) ? (raw as FeedbackStatus) : 'PENDING';
}

function mapDetailRow(row: Record<string, unknown>): FeedbackDetailRow {
  // 行键已被 toCamelList 转为 camelCase：message_id -> messageId, content_raw -> contentRaw 等
  const createdAt = row.createdAt;
  const handledAt = row.handledAt;
  return {
    id: Number(row.id),
    messageId: Number(row.messageId),
    sessionId: Number(row.sessionId),
    userId: Number(row.userId),
    username: asString(row.username),
    displayName: asString(row.displayName),
    agentId: row.agentId == null ? null : Number(row.agentId),
    agentName: asString(row.agentName),
    reason: row.reason as FeedbackReason,
    source: asSource(row.source),
    status: asStatus(row.status),
    handledBy: row.handledBy == null ? null : Number(row.handledBy),
    handledByName: asString(row.handledByName),
    handledAt: handledAt == null ? null : handledAt instanceof Date ? handledAt.toISOString() : String(handledAt),
    experienceId: row.experienceId == null ? null : Number(row.experienceId),
    sameGroupCount: Number(row.sameGroupCount ?? 0),
    messageExists: Number(row.messageExists ?? 0) === 1,
    content: row.contentRaw == null ? null : String(row.contentRaw),
    toolSummary: row.toolSummaryRaw == null ? null : String(row.toolSummaryRaw),
    toolCallCount: Number(row.toolCallCount ?? 0),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}
