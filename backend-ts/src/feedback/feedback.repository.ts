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
 * 处理态：PENDING 是唯一入口态；CONVERTED 与 DISMISSED 均为终态，
 * 不可互相流转、不可回退（技术方案 §4.1）。
 */
export const FEEDBACK_STATUSES = ['PENDING', 'CONVERTED', 'DISMISSED'] as const satisfies readonly FeedbackStatus[];

/** 批量 CAS 的 id 上限：防止一次请求带进过大的 IN 列表。 */
const MAX_CAS_IDS = 100;

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
  contentPreview: string | null;
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
              f.status, f.handled_by, f.handled_at, f.experience_id,
              u.username, u.display_name,
              hu.username AS handled_by_name,
              a.name AS agent_name,
              (SELECT COUNT(*) FROM message_feedback g
                WHERE g.agent_id <=> f.agent_id AND g.reason = f.reason AND g.status = 'PENDING') AS same_group_count,
              LEFT(m.content, 200) AS content_raw
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

  /**
   * 批量 CAS：只把仍为 PENDING 的行改为 CONVERTED。返回受影响行数，
   * 与传入 id 数量不等即说明有行已被其他管理员处理（并发 convert / 已 dismiss）。
   */
  casMarkConverted(ids: number[], operatorId: number): Promise<number> {
    return this.casUpdateStatus(ids, 'CONVERTED', operatorId);
  }

  /** 批量忽略：与 convert 同款 CAS，只是目标终态为 DISMISSED。 */
  markDismissed(ids: number[], operatorId: number): Promise<number> {
    return this.casUpdateStatus(ids, 'DISMISSED', operatorId);
  }

  /**
   * 回写经验关联：一次转换可能写多条经验，单值列只记第一条
   * （技术方案 §5.2「多经验与 experience_id 的对应关系」）。
   */
  bindExperience(ids: number[], experienceId: number, operatorId: number): Promise<void> {
    return this.db.execute(
      `UPDATE message_feedback SET experience_id = ?, handled_by = ? WHERE id IN (${placeholders(ids.length)})`,
      [experienceId, operatorId, ...ids],
    ).then(() => undefined);
  }

  /** 事务外预校验用：按 id 取反馈行的处理态、归属快照与原因。 */
  listByIds(ids: number[]): Promise<Array<{
    id: number;
    status: FeedbackStatus;
    agentId: number | null;
    messageId: number;
    sessionId: number;
    reason: FeedbackReason;
  }>> {
    return this.db.query<Record<string, unknown>>(
      `SELECT id, status, agent_id, message_id, session_id, reason FROM message_feedback WHERE id IN (${placeholders(ids.length)})`,
      ids,
    ).then((rows) => rows.map((row) => ({
      id: Number(row.id),
      status: asStatus(row.status),
      agentId: row.agentId == null ? null : Number(row.agentId),
      messageId: Number(row.messageId),
      sessionId: Number(row.sessionId),
      reason: row.reason as FeedbackReason,
    })));
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
    contentPreview: row.contentRaw == null ? null : String(row.contentRaw),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}
