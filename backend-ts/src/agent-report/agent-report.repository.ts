import type { Db } from '../db/db.js';

import type { AgentReportCategory, AgentReportSeverity, AgentReportStatus } from '@mao/contracts';

export type { AgentReportCategory, AgentReportSeverity, AgentReportStatus };

/** 运行时常量数组：契约联合的事实源（`as const satisfies` 守住穷尽性）。 */
export const AGENT_REPORT_CATEGORIES = [
  'system_vulnerability', 'self_bug', 'tool_defect', 'skill_defect', 'malicious_instruction', 'other',
] as const satisfies readonly AgentReportCategory[];

export const AGENT_REPORT_SEVERITIES = [
  'low', 'medium', 'high', 'critical',
] as const satisfies readonly AgentReportSeverity[];

export const AGENT_REPORT_STATUSES = [
  'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED',
] as const satisfies readonly AgentReportStatus[];

/** 终态：不可再流转（UI 不再给操作，updateStatus 的 CAS 也挡）。 */
export const AGENT_REPORT_TERMINAL_STATUSES = [
  'RESOLVED', 'DISMISSED',
] as const satisfies readonly AgentReportStatus[];

export interface AgentReportInsert {
  sessionId: number;
  userId: number | null;
  agentId: number | null;
  category: AgentReportCategory;
  severity: AgentReportSeverity;
  title: string;
  detail: string | null;
}

export interface AgentReportListFilter {
  status?: string;
  category?: string;
  severity?: string;
  startDate?: string;
  endDate?: string;
  offset: number;
  limit: number;
}

export interface AgentReportRow {
  id: number;
  sessionId: number | null;
  userId: number | null;
  username: string | null;
  agentId: number | null;
  agentName: string | null;
  category: AgentReportCategory;
  severity: AgentReportSeverity;
  title: string;
  detail: string | null;
  status: AgentReportStatus;
  resolutionNote: string | null;
  resolvedBy: number | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * agent_report 表读模型。行键经 db 层 toCamelList 转为 camelCase；
 * 会话 / 用户 / Agent 不做外键（删除后上报保留），LEFT JOIN 取名字。
 */
export class AgentReportRepository {
  constructor(private readonly db: Db) {}

  async insert(input: AgentReportInsert): Promise<number> {
    return this.db.insert('agent_report', {
      sessionId: input.sessionId,
      userId: input.userId,
      agentId: input.agentId,
      category: input.category,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      status: 'OPEN',
    });
  }

  /** 会话内去重：同 session + category + title（截断后口径，由 service 保证）命中即重复。 */
  async findDuplicate(sessionId: number, category: string, title: string): Promise<boolean> {
    const row = await this.db.queryOne<{ id: number }>(
      'SELECT id FROM agent_report WHERE session_id = ? AND category = ? AND title = ? LIMIT 1',
      [sessionId, category, title],
    );
    return row != null;
  }

  /** 会话终身累计条数（含已处置）：每会话限流计数口径。 */
  async countBySession(sessionId: number): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM agent_report WHERE session_id = ?',
      [sessionId],
    );
    return row?.c ?? 0;
  }

  countTotal(filter: Omit<AgentReportListFilter, 'offset' | 'limit'>): Promise<number> {
    const { where, params } = buildListWhere(filter);
    return this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM agent_report r ${where}`,
      params,
    ).then((row) => row?.c ?? 0);
  }

  /** 状态统计条：各状态数量（不过滤，列表页顶部常显）。 */
  countByStatus(): Promise<Array<{ status: string; count: number }>> {
    return this.db.query<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM agent_report GROUP BY status',
    );
  }

  pageList(filter: AgentReportListFilter): Promise<AgentReportRow[]> {
    const { where, params } = buildListWhere(filter);
    return this.db.query<Record<string, unknown>>(
      `SELECT r.id, r.session_id, r.user_id, r.agent_id, r.category, r.severity, r.title,
              r.status, r.resolution_note, r.resolved_by, r.resolved_at, r.created_at, r.updated_at,
              u.username, a.name AS agent_name, ru.username AS resolved_by_name
       FROM agent_report r
       LEFT JOIN user u ON u.id = r.user_id
       LEFT JOIN agent a ON a.id = r.agent_id
       LEFT JOIN user ru ON ru.id = r.resolved_by
       ${where}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ? OFFSET ?`,
      [...params, filter.limit, filter.offset],
    ).then((rows) => rows.map(mapRow));
  }

  async selectById(id: number): Promise<AgentReportRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      `SELECT r.id, r.session_id, r.user_id, r.agent_id, r.category, r.severity, r.title, r.detail,
              r.status, r.resolution_note, r.resolved_by, r.resolved_at, r.created_at, r.updated_at,
              u.username, a.name AS agent_name, ru.username AS resolved_by_name
       FROM agent_report r
       LEFT JOIN user u ON u.id = r.user_id
       LEFT JOIN agent a ON a.id = r.agent_id
       LEFT JOIN user ru ON ru.id = r.resolved_by
       WHERE r.id = ?`,
      [id],
    );
    return row == null ? null : mapRow(row);
  }

  /**
   * 状态流转 CAS：sourceStatuses 限定合法源态（OPEN → ACKNOWLEDGED/RESOLVED/DISMISSED；
   * ACKNOWLEDGED → RESOLVED/DISMISSED；终态不在任何源态里）。终态落 resolved_* 三列，
   * ACKNOWLEDGED 不动它们。返回受影响行数（0 = 并发已处置或状态机非法）。
   */
  async updateStatus(
    id: number,
    target: AgentReportStatus,
    sourceStatuses: readonly AgentReportStatus[],
    operatorId: number,
    note: string | null,
  ): Promise<number> {
    const terminal = (AGENT_REPORT_TERMINAL_STATUSES as readonly string[]).includes(target);
    const setClause = terminal
      ? 'status = ?, resolution_note = ?, resolved_by = ?, resolved_at = NOW()'
      : 'status = ?';
    const params = terminal
      ? [target, note, operatorId, id, ...sourceStatuses]
      : [target, id, ...sourceStatuses];
    const result = await this.db.execute(
      `UPDATE agent_report SET ${setClause}
       WHERE id = ? AND status IN (${sourceStatuses.map(() => '?').join(', ')})`,
      params,
    );
    return result.affectedRows;
  }
}

function buildListWhere(filter: Omit<AgentReportListFilter, 'offset' | 'limit'>): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    conditions.push('r.status = ?');
    params.push(filter.status);
  }
  if (filter.category) {
    conditions.push('r.category = ?');
    params.push(filter.category);
  }
  if (filter.severity) {
    conditions.push('r.severity = ?');
    params.push(filter.severity);
  }
  if (filter.startDate) {
    conditions.push('r.created_at >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate) {
    conditions.push('r.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(filter.endDate);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

function asString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function asDateString(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): AgentReportRow {
  return {
    id: Number(row.id),
    sessionId: row.sessionId == null ? null : Number(row.sessionId),
    userId: row.userId == null ? null : Number(row.userId),
    username: asString(row.username),
    agentId: row.agentId == null ? null : Number(row.agentId),
    agentName: asString(row.agentName),
    category: String(row.category) as AgentReportCategory,
    severity: String(row.severity) as AgentReportSeverity,
    title: String(row.title),
    detail: asString(row.detail),
    status: String(row.status) as AgentReportStatus,
    resolutionNote: asString(row.resolutionNote),
    resolvedBy: row.resolvedBy == null ? null : Number(row.resolvedBy),
    resolvedByName: asString(row.resolvedByName),
    resolvedAt: asDateString(row.resolvedAt),
    createdAt: asDateString(row.createdAt) ?? '',
    updatedAt: asDateString(row.updatedAt) ?? '',
  };
}
