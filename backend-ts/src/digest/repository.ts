import type { Db } from '../db/db.js';
import type { DigestPreference, DigestPreferenceRow } from './types.js';

/**
 * 每日运营摘要仓储（技术方案 §5.2）：六板块聚合查询 + 偏好 CRUD。
 *
 * 三条硬约束：
 * 1. 所有聚合语句带 user_id 条件（JOIN 归属表取 user_id），跨用户天然返回空。
 * 2. 窗口一律半开区间 [start, end)，由 service 按 Asia/Shanghai 昨天推算后传入。
 * 3. 审批待办是状态量查询（无窗口条件），其余五个板块都是窗口聚合。
 */
export class DigestRepository {
  constructor(private readonly db: Db) {}

  // ─── 偏好 ───

  findPreference(userId: number): Promise<DigestPreferenceRow | null> {
    return this.db.queryOne<DigestPreferenceRow>(
      `SELECT user_id AS userId, enabled, push_time AS pushTime, outbound_enabled AS outboundEnabled,
              last_digest_date AS lastDigestDate
       FROM user_digest_preference WHERE user_id = ?`,
      [userId],
    );
  }

  /** 调度入口：所有开启总开关的用户（last_digest_date 判定在调度器内做）。 */
  listEnabledUsers(): Promise<DigestPreferenceRow[]> {
    return this.db.query<DigestPreferenceRow>(
      `SELECT user_id AS userId, enabled, push_time AS pushTime, outbound_enabled AS outboundEnabled,
              last_digest_date AS lastDigestDate
       FROM user_digest_preference WHERE enabled = 1`,
    );
  }

  /** 懒建行 + last-write-wins（对齐 user_inbox_preference 无乐观锁）；不动 last_digest_date。 */
  async upsertPreference(row: {
    userId: number;
    enabled: boolean;
    pushTime: string;
    outboundEnabled: boolean;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO user_digest_preference (user_id, enabled, push_time, outbound_enabled)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         push_time = VALUES(push_time),
         outbound_enabled = VALUES(outbound_enabled)`,
      [row.userId, row.enabled ? 1 : 0, row.pushTime, row.outboundEnabled ? 1 : 0],
    );
  }

  /**
   * 标记 coveredDate 已处理（安静日也写——避免每分钟重复聚合）。
   * 单调不回退：仅当库里为空或更早日期才写，防止试发/并发 tick 把新状态覆盖回旧值。
   */
  async markProcessed(userId: number, coveredDate: string): Promise<void> {
    await this.db.execute(
      `UPDATE user_digest_preference SET last_digest_date = ?
       WHERE user_id = ? AND (last_digest_date IS NULL OR last_digest_date < ?)`,
      [coveredDate, userId, coveredDate],
    );
  }

  // ─── 板块 1：任务成败（notification TASK_COMPLETED / TASK_FAILED） ───

  async countTaskTerminal(
    userId: number,
    start: string,
    end: string,
  ): Promise<{ completed: number; failed: number }> {
    const rows = await this.db.query<{ kind: string; c: number }>(
      `SELECT kind, COUNT(*) AS c FROM notification
       WHERE user_id = ? AND kind IN ('TASK_COMPLETED', 'TASK_FAILED')
         AND created_at >= ? AND created_at < ?
       GROUP BY kind`,
      [userId, start, end],
    );
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.kind === 'TASK_COMPLETED') completed = Number(row.c);
      if (row.kind === 'TASK_FAILED') failed = Number(row.c);
    }
    return { completed, failed };
  }

  /** 失败任务 Top N：标题 + 失败原因（content 原文）+ 会话跳转目标。 */
  listFailedTasks(userId: number, start: string, end: string, limit: number): Promise<Array<{
    sessionId: number | null;
    title: string;
    reason: string;
  }>> {
    return this.db.query(
      `SELECT session_id AS sessionId, title, content AS reason FROM notification
       WHERE user_id = ? AND kind = 'TASK_FAILED'
         AND created_at >= ? AND created_at < ?
       ORDER BY id DESC LIMIT ?`,
      [userId, start, end, limit],
    );
  }

  // ─── 板块 2：定时任务执行（scheduled_task_run JOIN scheduled_task） ───

  async countScheduledRuns(userId: number, start: string, end: string): Promise<{
    total: number;
    completed: number;
    failed: number;
  }> {
    const rows = await this.db.query<{ status: string; c: number }>(
      `SELECT r.status, COUNT(*) AS c
       FROM scheduled_task_run r JOIN scheduled_task t ON r.task_id = t.id
       WHERE t.user_id = ? AND r.created_at >= ? AND r.created_at < ?
       GROUP BY r.status`,
      [userId, start, end],
    );
    let total = 0;
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const count = Number(row.c);
      total += count;
      if (row.status === 'COMPLETED') completed = count;
      if (row.status === 'FAILED') failed = count;
    }
    return { total, completed, failed };
  }

  /** 窗口内被自动暂停的定时任务（notification SCHEDULED_TASK_PAUSED，payload.taskId）。 */
  async listPausedTasks(userId: number, start: string, end: string): Promise<Array<{
    taskId: number | null;
    name: string;
  }>> {
    const rows = await this.db.query<{ title: string; payloadJson: string | null }>(
      `SELECT title, payload_json AS payloadJson FROM notification
       WHERE user_id = ? AND kind = 'SCHEDULED_TASK_PAUSED'
         AND created_at >= ? AND created_at < ?
       ORDER BY id DESC`,
      [userId, start, end],
    );
    return rows.map((row) => ({
      taskId: readPayloadNumber(row.payloadJson, 'taskId'),
      name: stripPausedTitle(row.title),
    }));
  }

  // ─── 板块 3：信号哨兵触发（signal_watcher_check JOIN signal_watcher） ───

  async countWatcherTriggers(userId: number, start: string, end: string): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM signal_watcher_check ch JOIN signal_watcher w ON ch.watcher_id = w.id
       WHERE w.user_id = ? AND ch.changed = 1
         AND ch.checked_at >= ? AND ch.checked_at < ?`,
      [userId, start, end],
    );
    return Number(row?.c ?? 0);
  }

  /** 窗口内被自动停用的哨兵（notification WATCHER_DISABLED，payload.watcherId）。 */
  async listDisabledWatchers(userId: number, start: string, end: string): Promise<Array<{
    watcherId: number | null;
    name: string;
  }>> {
    const rows = await this.db.query<{ title: string; payloadJson: string | null }>(
      `SELECT title, payload_json AS payloadJson FROM notification
       WHERE user_id = ? AND kind = 'WATCHER_DISABLED'
         AND created_at >= ? AND created_at < ?
       ORDER BY id DESC`,
      [userId, start, end],
    );
    return rows.map((row) => ({
      watcherId: readPayloadNumber(row.payloadJson, 'watcherId'),
      name: stripDisabledTitle(row.title),
    }));
  }

  // ─── 板块 4：审批待办挂起（notification APPROVAL_PENDING，无窗口） ───

  async countPendingApprovals(userId: number): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM notification
       WHERE user_id = ? AND kind = 'APPROVAL_PENDING' AND is_read = 0`,
      [userId],
    );
    return Number(row?.c ?? 0);
  }

  listPendingApprovals(userId: number, limit: number): Promise<Array<{
    sessionId: number | null;
    title: string;
  }>> {
    return this.db.query(
      `SELECT session_id AS sessionId, title FROM notification
       WHERE user_id = ? AND kind = 'APPROVAL_PENDING' AND is_read = 0
       ORDER BY id DESC LIMIT ?`,
      [userId, limit],
    );
  }

  // ─── 板块 5：成本（llm_call.cost_micros，V138 写时快照） ───

  /** 按 Agent 聚合；micros 为 NULL 的行不计合计、只进 unpriced 计数。 */
  async sumCostByAgent(userId: number, start: string, end: string): Promise<Array<{
    agentId: number | null;
    micros: number | null;
    calls: number;
    unpriced: number;
  }>> {
    const rows = await this.db.query<{
      agentId: number | null;
      micros: number | null;
      calls: number;
      unpriced: number;
    }>(
      `SELECT agent_id AS agentId, SUM(cost_micros) AS micros, COUNT(*) AS calls,
              SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM llm_call
       WHERE user_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY agent_id
       ORDER BY micros DESC`,
      [userId, start, end],
    );
    return rows.map((row) => ({
      agentId: row.agentId == null ? null : Number(row.agentId),
      micros: row.micros == null ? null : Number(row.micros),
      calls: Number(row.calls),
      unpriced: Number(row.unpriced),
    }));
  }

  /** Agent 展示名批量回填（llm_call 不冗余 agent 名）。 */
  async findAgentNames(agentIds: number[]): Promise<Map<number, string>> {
    if (agentIds.length === 0) return new Map();
    const placeholders = agentIds.map(() => '?').join(', ');
    const rows = await this.db.query<{ id: number; name: string }>(
      `SELECT id, name FROM agent WHERE id IN (${placeholders})`,
      agentIds,
    );
    return new Map(rows.map((row) => [Number(row.id), row.name]));
  }

  // ─── 板块 6：开放接口调用（open_api_call_log，V145） ───

  async countOpenApiCalls(userId: number, start: string, end: string): Promise<{
    total: number;
    rejected: number;
  }> {
    const rows = await this.db.query<{ outcome: string; c: number }>(
      `SELECT outcome, COUNT(*) AS c FROM open_api_call_log
       WHERE user_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY outcome`,
      [userId, start, end],
    );
    let total = 0;
    let rejected = 0;
    for (const row of rows) {
      const count = Number(row.c);
      total += count;
      if (row.outcome === 'rejected') rejected = count;
    }
    return { total, rejected };
  }
}

/** payload_json 里取数字字段；解析失败 / 缺失 / 非数字一律 null（坏数据不阻断摘要）。 */
function readPayloadNumber(payloadJson: string | null, key: string): number | null {
  if (payloadJson == null || payloadJson === '') return null;
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 「定时任务已自动暂停：{name}」→ name；无前缀分隔符时回落原标题。 */
function stripPausedTitle(title: string): string {
  const marker = '定时任务已自动暂停：';
  return title.startsWith(marker) ? title.slice(marker.length) : title;
}

/** 「信号哨兵已自动停用：{name}」→ name；无前缀分隔符时回落原标题。 */
function stripDisabledTitle(title: string): string {
  const marker = '信号哨兵已自动停用：';
  return title.startsWith(marker) ? title.slice(marker.length) : title;
}

export type { DigestPreference };
