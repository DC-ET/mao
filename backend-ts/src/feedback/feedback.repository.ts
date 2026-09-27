import type { Db } from '../db/db.js';

export const FEEDBACK_REASONS = ['WRONG_RESULT', 'SLOW_RESPONSE', 'NOT_SOLVED', 'OTHER'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export interface FeedbackSummaryRow {
  reason: string;
  count: number;
}

export interface FeedbackDailyRow {
  date: string;
  count: number;
}

export interface FeedbackDetailFilter {
  reason?: string;
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
  contentPreview: string | null;
  createdAt: string;
}

export class FeedbackRepository {
  constructor(private readonly db: Db) {}

  upsert(messageId: number, sessionId: number, userId: number, agentId: number | null, reason: FeedbackReason): Promise<void> {
    return this.db.execute(
      `INSERT INTO message_feedback (message_id, session_id, user_id, agent_id, reason)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason)`,
      [messageId, sessionId, userId, agentId, reason],
    ).then(() => undefined);
  }

  async deleteByMessageId(messageId: number): Promise<boolean> {
    const result = await this.db.execute('DELETE FROM message_feedback WHERE message_id = ?', [messageId]);
    return result.affectedRows > 0;
  }

  listMessageIdsBySession(sessionId: number): Promise<number[]> {
    // 行键经 toCamelList 已转为 camelCase：message_id -> messageId
    return this.db.query<{ messageId: number }>(
      'SELECT message_id FROM message_feedback WHERE session_id = ?',
      [sessionId],
    ).then((rows) => rows.map((r) => Number(r.messageId)));
  }

  countTotal(filter: { reason?: string; startDate?: string; endDate?: string }): Promise<number> {
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
      `SELECT f.id, f.message_id, f.session_id, f.user_id, f.agent_id, f.reason, f.created_at,
              u.username, u.display_name,
              a.name AS agent_name,
              LEFT(m.content, 200) AS content_raw
       FROM message_feedback f
       LEFT JOIN user u ON u.id = f.user_id
       LEFT JOIN agent a ON a.id = f.agent_id
       LEFT JOIN message m ON m.id = f.message_id
       ${where}
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT ? OFFSET ?`,
      pagination,
    ).then((rows) => rows.map((row) => mapDetailRow(row)));
  }
}

function buildDetailWhere(filter: { reason?: string; startDate?: string; endDate?: string }): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.reason) {
    conditions.push('f.reason = ?');
    params.push(filter.reason);
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

function mapDetailRow(row: Record<string, unknown>): FeedbackDetailRow {
  // 行键已被 toCamelList 转为 camelCase：message_id -> messageId, content_raw -> contentRaw 等
  const createdAt = row.createdAt;
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
    contentPreview: row.contentRaw == null ? null : String(row.contentRaw),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}
