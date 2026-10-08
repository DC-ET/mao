import { describe, expect, it, vi } from 'vitest';
import {
  InboxRepository,
  toInboxItem,
  type NotificationRow,
  type UserInboxPreferenceRow,
} from './inbox.repository.js';

/**
 * 内存 fake：实现 `uk_notification_dedup` 唯一键与
 * `ON DUPLICATE KEY UPDATE id = id` 的「插入即忽略」语义。
 *
 * 为什么不能只用 vi.fn() mock：唯一键的「同 dedup_key 只落一行、且不刷新
 * created_at、不把已读打回未读」恰恰是本方案幂等主防线，纯 mock 触达不到。
 */
function makeUniqueKeyDb() {
  const rows = new Map<string, NotificationRow & { readAt: string | null }>();
  let nextId = 1;
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/^INSERT INTO notification/.test(sql)) {
        const [userId, kind, title, content, sessionId, payloadJson, dedupKey] =
          params as [number, string, string, string | null, number | null, string | null, string];
        if (rows.has(dedupKey)) {
          // MySQL 实际行为：`id = id` 时整行不变（不是 VALUES() 覆盖）
          return { affectedRows: 0, insertId: 0 };
        }
        const id = nextId++;
        rows.set(dedupKey, {
          id, userId, kind, title, content: content ?? null,
          isRead: 0, readAt: null, sessionId: sessionId ?? null,
          payloadJson: payloadJson ?? null, dedupKey, createdAt: `2026-10-04T10:00:0${id}`,
        });
        return { affectedRows: 1, insertId: id };
      }
      if (/^UPDATE notification SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = \? AND user_id = \?/.test(sql)) {
        const [id, userId] = params as [number, number];
        const row = [...rows.values()].find((r) => r.id === id && r.userId === userId);
        if (!row || row.isRead === 1) return { affectedRows: 0 };
        row.isRead = 1;
        row.readAt = '2026-10-04T11:00:00';
        return { affectedRows: 1 };
      }
      if (/^UPDATE notification SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = \? AND is_read = 0/.test(sql)) {
        let affected = 0;
        for (const row of rows.values()) {
          if (row.userId === params[0] && row.isRead === 0) {
            row.isRead = 1;
            row.readAt = '2026-10-04T11:00:00';
            affected++;
          }
        }
        return { affectedRows: affected };
      }
      if (/^UPDATE notification SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = \? AND dedup_key = \?/.test(sql)) {
        const [userId, dedupKey] = params as [number, string];
        const row = rows.get(dedupKey);
        if (!row || row.userId !== userId || row.isRead === 1) return { affectedRows: 0 };
        row.isRead = 1;
        row.readAt = '2026-10-04T11:00:00';
        return { affectedRows: 1 };
      }
      if (/^DELETE FROM notification WHERE id = \? AND user_id = \?$/.test(sql)) {
        const [id, userId] = params as [number, number];
        const row = [...rows.values()].find((r) => r.id === id && r.userId === userId);
        return { affectedRows: row != null && rows.delete(row.dedupKey) ? 1 : 0 };
      }
      if (/^DELETE FROM notification WHERE created_at < \?$/.test(sql)) {
        const cutoff = String(params[0]);
        let affected = 0;
        for (const [key, row] of [...rows.entries()]) {
          if (row.createdAt < cutoff) {
            rows.delete(key);
            affected++;
          }
        }
        return { affectedRows: affected };
      }
      if (/^INSERT INTO user_inbox_preference/.test(sql)) {
        // 列序（V139）：user_id, task, question, approval, subagent, budget_warn, system_notify
        const row: UserInboxPreferenceRow = {
          userId: params[0] as number,
          taskCompletedEnabled: params[1] as number,
          questionPendingEnabled: params[2] as number,
          approvalPendingEnabled: params[3] as number,
          subagentDoneEnabled: params[4] as number,
          budgetWarnEnabled: params[5] as number,
          systemNotifyEnabled: params[6] as number,
        };
        prefs.set(row.userId, row);
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    queryOne: async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/SELECT COUNT\(\*\) AS c FROM notification WHERE user_id = \? AND is_read = 0/.test(sql)) {
        const count = [...rows.values()].filter((r) => r.userId === params[0] && r.isRead === 0).length;
        return { c: count };
      }
      if (/FROM notification WHERE user_id = \? AND dedup_key = \?/.test(sql)) {
        const row = rows.get(String(params[1]));
        return row != null && row.userId === params[0] ? row : null;
      }
      if (/FROM user_inbox_preference WHERE user_id = \?/.test(sql)) {
        return prefs.get(params[0] as number) ?? null;
      }
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
        const unreadOnly = /AND is_read = 0/.test(sql);
        const total = [...rows.values()].filter((r) => r.userId === params[0]
          && (unreadOnly ? r.isRead === 0 : true)).length;
        return { total };
      }
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      const [userId] = params as [number, unknown];
      const unreadOnly = /AND is_read = 0/.test(sql);
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      return [...rows.values()]
        .filter((r) => r.userId === userId && (unreadOnly ? r.isRead === 0 : true))
        .sort((a, b) => (a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1))
        .slice(offset, offset + limit);
    },
  };
  const prefs = new Map<number, UserInboxPreferenceRow>();
  return { repo: new InboxRepository(db as never), db, rows, prefs, captured };
}

function sampleRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 1, userId: 7, kind: 'TASK_COMPLETED', title: '任务已完成：整理文档',
    content: null, isRead: 0, readAt: null, sessionId: 11,
    payloadJson: '{"source":"MANUAL"}', dedupKey: '7:TASK_COMPLETED:11:exec-1',
    createdAt: '2026-10-04T10:00:00',
    ...overrides,
  };
}

describe('InboxRepository 写入与幂等', () => {
  it('insertIgnore 用 `ON DUPLICATE KEY UPDATE id = id`，保证插入即忽略', async () => {
    const { repo, captured } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 't', content: null,
      sessionId: 11, payloadJson: '{"source":"MANUAL"}', dedupKey: '7:TASK_COMPLETED:11:exec-1',
    });
    expect(captured[0].sql).toContain('ON DUPLICATE KEY UPDATE id = id');
  });

  it('同 dedup_key 二次插入只落一行，且不刷新 created_at、不把已读打回未读', async () => {
    const { repo, rows } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 't', content: null,
      sessionId: 11, payloadJson: '{"source":"MANUAL"}', dedupKey: '7:TASK_COMPLETED:11:exec-1',
    });
    const first = rows.get('7:TASK_COMPLETED:11:exec-1')!;
    first.isRead = 1;
    first.readAt = '2026-10-04T11:00:00';

    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: '第二次', content: 'x',
      sessionId: 11, payloadJson: '{"source":"SCHEDULED"}', dedupKey: '7:TASK_COMPLETED:11:exec-1',
    });
    expect(rows.size).toBe(1);
    expect(rows.get('7:TASK_COMPLETED:11:exec-1')!.isRead).toBe(1);
    expect(rows.get('7:TASK_COMPLETED:11:exec-1')!.title).toBe('t');
    expect(rows.get('7:TASK_COMPLETED:11:exec-1')!.createdAt).toBe('2026-10-04T10:00:01');
  });

  it('不同用户同 session 同 execution 各落一行（dedup_key 含 userId）', async () => {
    const { repo, rows } = makeUniqueKeyDb();
    const insert = (userId: number, key: string) => repo.insertIgnore({
      userId, kind: 'TASK_COMPLETED', title: 't', content: null,
      sessionId: 11, payloadJson: null, dedupKey: key,
    });
    await insert(7, '7:TASK_COMPLETED:11:exec-1');
    await insert(8, '8:TASK_COMPLETED:11:exec-1');
    expect(rows.size).toBe(2);
  });
});

describe('InboxRepository 分页与未读过滤', () => {
  it('list 带 user_id 条件并按 created_at/id 倒序，unreadOnly 追加 is_read = 0', async () => {
    const { repo, captured } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 'a', content: null,
      sessionId: 11, payloadJson: null, dedupKey: '7:TASK_COMPLETED:11:e1',
    });
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 'b', content: null,
      sessionId: 12, payloadJson: null, dedupKey: '7:TASK_COMPLETED:12:e2',
    });
    const all = await repo.list({ userId: 7, page: 1, size: 20 });
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.title)).toEqual(['b', 'a']);

    const unread = await repo.list({ userId: 7, page: 1, size: 20, unreadOnly: true });
    expect(unread.total).toBe(2);

    const markSql = captured.map((c) => c.sql).join('\n');
    expect(markSql).toContain('user_id = ?');
    expect(await repo.list({ userId: 8, page: 1, size: 20 })).toMatchObject({ total: 0, rows: [] });
  });

  it('countUnread 只数该用户未读', async () => {
    const { repo } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 'a', content: null,
      sessionId: 11, payloadJson: null, dedupKey: '7:TASK_COMPLETED:11:e1',
    });
    await expect(repo.countUnread(7)).resolves.toBe(1);
    await expect(repo.countUnread(8)).resolves.toBe(0);
  });
});

describe('InboxRepository 已读 / 删除 / 生命周期联动', () => {
  it('markRead / deleteById 均以 user_id 为边界，跨用户影响 0 行', async () => {
    const { repo } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 'a', content: null,
      sessionId: 11, payloadJson: null, dedupKey: '7:TASK_COMPLETED:11:e1',
    });
    await repo.insertIgnore({
      userId: 8, kind: 'TASK_COMPLETED', title: 'b', content: null,
      sessionId: 11, payloadJson: null, dedupKey: '8:TASK_COMPLETED:11:e1',
    });
    // 用户 8 的行 id=2；用别人的 userId 去标已读/删除都应无效
    await expect(repo.markRead(2, 7)).resolves.toBe(false);
    await expect(repo.deleteById(2, 7)).resolves.toBe(false);
    await expect(repo.markRead(1, 8)).resolves.toBe(false);
    await expect(repo.deleteById(1, 7)).resolves.toBe(true);
  });

  it('markReadByDedupKey 幂等：第二次 UPDATE 影响 0 行不报错', async () => {
    const { repo, captured } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'QUESTION_PENDING', title: 'q', content: null,
      sessionId: 11, payloadJson: null, dedupKey: '7:QUESTION_PENDING:11:req-1',
    });
    await expect(repo.markReadByDedupKey(7, '7:QUESTION_PENDING:11:req-1')).resolves.toBe(true);
    await expect(repo.markReadByDedupKey(7, '7:QUESTION_PENDING:11:req-1')).resolves.toBe(false);
    await expect(repo.markReadByDedupKey(8, '7:QUESTION_PENDING:11:req-1')).resolves.toBe(false);
    const sql = captured.map((c) => c.sql).find((s) => /dedup_key = \?/.test(s));
    expect(sql).toContain('user_id = ? AND dedup_key = ?');
    // 不做尾段 LIKE 扫描
    expect(sql).not.toContain('LIKE');
  });

  it('markAllRead 返回影响行数，findByDedupKey 带 user_id 边界', async () => {
    const { repo } = makeUniqueKeyDb();
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 'a', content: null,
      sessionId: 11, payloadJson: null, dedupKey: '7:TASK_COMPLETED:11:e1',
    });
    await repo.insertIgnore({
      userId: 7, kind: 'TASK_COMPLETED', title: 'b', content: null,
      sessionId: 12, payloadJson: null, dedupKey: '7:TASK_COMPLETED:12:e2',
    });
    await expect(repo.markAllRead(7)).resolves.toBe(2);
    await expect(repo.markAllRead(7)).resolves.toBe(0);
    await expect(repo.findByDedupKey(7, '7:TASK_COMPLETED:11:e1')).resolves.toMatchObject({ title: 'a' });
    await expect(repo.findByDedupKey(8, '7:TASK_COMPLETED:11:e1')).resolves.toBeNull();
  });

  it('deleteHistory 按 created_at 单条删除，不做 LIMIT 分批', async () => {
    const { repo, captured } = makeUniqueKeyDb();
    await repo.deleteHistory('2026-10-04T10:00:01');
    const sql = captured[0].sql;
    expect(sql).toBe('DELETE FROM notification WHERE created_at < ?');
    expect(sql).not.toContain('LIMIT');
  });
});

describe('InboxRepository 偏好', () => {
  it('无偏好行返回 null（由 service 按列默认值补齐）', async () => {
    const { repo } = makeUniqueKeyDb();
    await expect(repo.findPreference(7)).resolves.toBeNull();
  });

  it('savePreference upsert 覆盖四列 + 系统通知开关（last-write-wins）', async () => {
    const { repo, prefs } = makeUniqueKeyDb();
    await repo.savePreference(7, {
      taskCompletedEnabled: true,
      questionPendingEnabled: false,
      approvalPendingEnabled: true,
      subagentDoneEnabled: true,
      systemNotifyEnabled: false,
      budgetWarnEnabled: true,
    });
    await expect(repo.findPreference(7)).resolves.toMatchObject({
      taskCompletedEnabled: 1,
      questionPendingEnabled: 0,
      approvalPendingEnabled: 1,
      subagentDoneEnabled: 1,
      systemNotifyEnabled: 0,
      budgetWarnEnabled: 1,
    });
    await repo.savePreference(7, {
      taskCompletedEnabled: false,
      questionPendingEnabled: true,
      approvalPendingEnabled: false,
      subagentDoneEnabled: false,
      systemNotifyEnabled: true,
      budgetWarnEnabled: false,
    });
    expect(prefs.size).toBe(1);
    await expect(repo.findPreference(7)).resolves.toMatchObject({
      taskCompletedEnabled: 0,
      questionPendingEnabled: 1,
      approvalPendingEnabled: 0,
      subagentDoneEnabled: 0,
      systemNotifyEnabled: 1,
      budgetWarnEnabled: 0,
    });
  });
});

describe('toInboxItem 行映射', () => {
  it('is_read/read_at/session_id 归一化，payload_json 损坏时降级为 null', () => {
    expect(toInboxItem(sampleRow())).toEqual({
      id: 1,
      kind: 'TASK_COMPLETED',
      title: '任务已完成：整理文档',
      content: null,
      isRead: false,
      readAt: null,
      sessionId: 11,
      payload: { source: 'MANUAL' },
      createdAt: '2026-10-04T10:00:00',
    });
    expect(toInboxItem(sampleRow({ payloadJson: '{broken', isRead: 1, readAt: '2026-10-04T11:00:00', sessionId: null })))
      .toMatchObject({ payload: null, isRead: true, readAt: '2026-10-04T11:00:00', sessionId: null });
  });
});

void vi;
