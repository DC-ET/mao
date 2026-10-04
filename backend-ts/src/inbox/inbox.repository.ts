import type { Db } from '../db/db.js';
import type { InboxKind, InboxItem } from '@mao/contracts';

/** 收件箱条目行（DB 直读；payload_json 由 mysql2 jsonStrings 以字符串返回）。 */
export interface NotificationRow {
  id: number;
  userId: number;
  kind: string;
  title: string;
  content: string | null;
  isRead: number;
  readAt: string | null;
  sessionId: number | null;
  payloadJson: string | null;
  dedupKey: string;
  createdAt: string;
}

/** 收件箱偏好行（无行时按列默认值：前三类开、子代理关）。 */
export interface UserInboxPreferenceRow {
  userId: number;
  taskCompletedEnabled: number;
  questionPendingEnabled: number;
  approvalPendingEnabled: number;
  subagentDoneEnabled: number;
  systemNotifyEnabled: number;
}

export interface InboxListFilter {
  userId: number;
  page: number;
  size: number;
  unreadOnly?: boolean;
}

/**
 * 站内收件箱仓储：薄封装（Db 直调 execute/query/queryOne，无 ORM），
 * 参照 feedback/feedback.repository.ts 的风格。
 *
 * 三条硬约束：
 * 1. 所有语句带 user_id 条件——跨用户访问天然返回空/404。
 * 2. insertIgnore 用 `ON DUPLICATE KEY UPDATE id = id`（插入即忽略），
 *    retry / 取消后重发 / 排队消费不得刷新 created_at 排序、不得把已读打回未读。
 * 3. 联动置已读只做完整 dedup_key 等值匹配（命中 uk_notification_dedup），不做 LIKE 扫描。
 */
export class InboxRepository {
  constructor(private readonly db: Db) {}

  /** 幂等写入：唯一键冲突即无操作（影响 0 行），不刷新 created_at、不改 is_read。 */
  async insertIgnore(row: {
    userId: number;
    kind: InboxKind;
    title: string;
    content: string | null;
    sessionId: number | null;
    payloadJson: string | null;
    dedupKey: string;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO notification (user_id, kind, title, content, session_id, payload_json, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [row.userId, row.kind, row.title, row.content, row.sessionId, row.payloadJson, row.dedupKey],
    );
  }

  async list(filter: InboxListFilter): Promise<{ rows: NotificationRow[]; total: number }> {
    const where = filter.unreadOnly === true
      ? 'WHERE user_id = ? AND is_read = 0'
      : 'WHERE user_id = ?';
    const params: unknown[] = [filter.userId];
    const rows = await this.db.query<NotificationRow>(
      `SELECT id, user_id AS userId, kind, title, content, is_read AS isRead, read_at AS readAt,
              session_id AS sessionId, payload_json AS payloadJson, dedup_key AS dedupKey, created_at AS createdAt
       FROM notification ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, filter.size, (filter.page - 1) * filter.size],
    );
    const countRow = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM notification ${where}`,
      params,
    );
    return { rows, total: Number(countRow?.total ?? 0) };
  }

  countUnread(userId: number): Promise<number> {
    return this.db.queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM notification WHERE user_id = ? AND is_read = 0',
      [userId],
    ).then((row) => Number(row?.c ?? 0));
  }

  /** 单条已读（带 user_id 边界，跨用户影响 0 行）。 */
  async markRead(id: number, userId: number): Promise<boolean> {
    const result = await this.db.execute(
      'UPDATE notification SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND is_read = 0',
      [id, userId],
    );
    return result.affectedRows > 0;
  }

  /** 全部已读（单条 UPDATE，命中 idx_notification_user_read）。 */
  async markAllRead(userId: number): Promise<number> {
    const result = await this.db.execute(
      'UPDATE notification SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0',
      [userId],
    );
    return result.affectedRows;
  }

  async deleteById(id: number, userId: number): Promise<boolean> {
    const result = await this.db.execute(
      'DELETE FROM notification WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    return result.affectedRows > 0;
  }

  /**
   * 联动置已读（提问已回答/取消/超时、审批已处理）：完整 dedup_key 等值匹配。
   * 幂等——重复触发影响 0 行，不报错。
   */
  async markReadByDedupKey(userId: number, dedupKey: string): Promise<boolean> {
    const result = await this.db.execute(
      'UPDATE notification SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND dedup_key = ? AND is_read = 0',
      [userId, dedupKey],
    );
    return result.affectedRows > 0;
  }

  findByDedupKey(userId: number, dedupKey: string): Promise<NotificationRow | null> {
    return this.db.queryOne<NotificationRow>(
      `SELECT id, user_id AS userId, kind, title, content, is_read AS isRead, read_at AS readAt,
              session_id AS sessionId, payload_json AS payloadJson, dedup_key AS dedupKey, created_at AS createdAt
       FROM notification WHERE user_id = ? AND dedup_key = ?`,
      [userId, dedupKey],
    );
  }

  /** 90 天清理：单条 DELETE，无分批（量级远小于 task_notification_delivery，KISS）。已读/未读都清。 */
  async deleteHistory(cutoff: string): Promise<number> {
    const result = await this.db.execute(
      'DELETE FROM notification WHERE created_at < ?',
      [cutoff],
    );
    return result.affectedRows;
  }

  findPreference(userId: number): Promise<UserInboxPreferenceRow | null> {
    return this.db.queryOne<UserInboxPreferenceRow>(
      `SELECT user_id AS userId, task_completed_enabled AS taskCompletedEnabled,
              question_pending_enabled AS questionPendingEnabled,
              approval_pending_enabled AS approvalPendingEnabled,
              subagent_done_enabled AS subagentDoneEnabled,
              system_notify_enabled AS systemNotifyEnabled
       FROM user_inbox_preference WHERE user_id = ?`,
      [userId],
    );
  }

  /** upsert（last-write-wins，同 user_weixin_preference 无乐观锁）。 */
  async savePreference(userId: number, flags: {
    taskCompletedEnabled: boolean;
    questionPendingEnabled: boolean;
    approvalPendingEnabled: boolean;
    subagentDoneEnabled: boolean;
    systemNotifyEnabled: boolean;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO user_inbox_preference
         (user_id, task_completed_enabled, question_pending_enabled, approval_pending_enabled,
          subagent_done_enabled, system_notify_enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         task_completed_enabled = VALUES(task_completed_enabled),
         question_pending_enabled = VALUES(question_pending_enabled),
         approval_pending_enabled = VALUES(approval_pending_enabled),
         subagent_done_enabled = VALUES(subagent_done_enabled),
         system_notify_enabled = VALUES(system_notify_enabled)`,
      [
        userId,
        flags.taskCompletedEnabled ? 1 : 0,
        flags.questionPendingEnabled ? 1 : 0,
        flags.approvalPendingEnabled ? 1 : 0,
        flags.subagentDoneEnabled ? 1 : 0,
        flags.systemNotifyEnabled ? 1 : 0,
      ],
    );
  }
}

/** 行 → VO。payload_json 解析失败视为无 payload，不让坏数据阻断列表渲染。 */
export function toInboxItem(row: NotificationRow): InboxItem {
  return {
    id: Number(row.id),
    kind: row.kind as InboxKind,
    title: row.title,
    content: row.content ?? null,
    isRead: Number(row.isRead) === 1,
    readAt: row.readAt ?? null,
    sessionId: row.sessionId == null ? null : Number(row.sessionId),
    payload: parsePayload(row.payloadJson),
    createdAt: row.createdAt,
  };
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
