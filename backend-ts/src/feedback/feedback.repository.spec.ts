import { describe, expect, it, vi } from 'vitest';
import { FeedbackRepository } from './feedback.repository.js';

/**
 * 不 mock SQL 生成逻辑的回归测试：捕获传给 Db 的 SQL 与参数，
 * 防止 buildDetailWhere（f. 前缀条件）与表别名不匹配、
 * 以及查询行键（camelCase）读取错位这类两轮审查中出现的真实 bug。
 */
function makeCaptureDb() {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const rowsByCall: Record<string, unknown[]> = {
    count: [{ c: 5 }],
    group: [{ reason: 'WRONG_RESULT', count: 5 }],
    ids: [{ messageId: 42 }],
    exists: [{ id: 1 }],
    detail: [{
      id: 1, messageId: 11, sessionId: 5, userId: 9, agentId: 2,
      reason: 'NO_REASON', source: 'feishu', createdAt: '2026-09-27T00:00:00.000Z',
      username: 'alice', displayName: 'Alice', agentName: 'Coder', contentRaw: 'hello',
    }],
  };
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/FROM message_feedback f\s+WHERE.*GROUP BY reason/s.test(sql)) return rowsByCall.group;
      if (/SELECT message_id FROM message_feedback/s.test(sql)) return rowsByCall.ids;
      if (/SELECT id FROM message_feedback/s.test(sql)) return rowsByCall.exists;
      if (/FROM message_feedback f/.test(sql) && /LEFT JOIN message m/s.test(sql)) return rowsByCall.detail;
      return [];
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/SELECT id FROM message_feedback WHERE message_id/s.test(sql)) return rowsByCall.exists[0];
      if (/FROM message_feedback f/.test(sql)) return rowsByCall.count[0];
      return null;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      return { affectedRows: 1 };
    }),
  };
  return { repo: new FeedbackRepository(db as never), captured };
}

describe('FeedbackRepository SQL 构造', () => {
  it('countTotalUsesTableAliasMatchingPrefixedConditions', async () => {
    const { repo, captured } = makeCaptureDb();
    const total = await repo.countTotal({ reason: 'WRONG_RESULT', startDate: '2026-09-01', endDate: '2026-09-27' });
    expect(total).toBe(5);
    const sql = captured[0].sql;
    // 条件带 f. 前缀时，表必须有 f 别名，否则 MySQL 1054
    expect(sql).toContain('FROM message_feedback f');
    expect(sql).toContain('f.reason = ?');
    expect(sql).toContain('f.created_at >= ?');
    expect(captured[0].params).toEqual(['WRONG_RESULT', '2026-09-01', '2026-09-27']);
  });

  it('sumByReasonAppliesDateFilterWithAlias', async () => {
    const { repo, captured } = makeCaptureDb();
    const rows = await repo.sumByReason('2026-09-01', '2026-09-27');
    expect(rows).toEqual([{ reason: 'WRONG_RESULT', count: 5 }]);
    const sql = captured[0].sql;
    expect(sql).toContain('FROM message_feedback f');
    expect(sql).toContain('f.created_at >= ?');
    expect(captured[0].params).toEqual(['2026-09-01', '2026-09-27']);
  });

  it('sumByDayUsesSameDateWhereAsSumByReason', async () => {
    const { repo, captured } = makeCaptureDb();
    await repo.sumByDay('2026-09-01', '2026-09-27');
    const sql = captured[0].sql;
    // 与 sumByReason 共用 buildDetailWhere：表别名 f + 前缀条件，避免两侧口径漂移
    expect(sql).toContain('FROM message_feedback f');
    expect(sql).toContain('f.created_at >= ?');
    expect(sql).toContain('DATE_FORMAT(f.created_at');
    expect(captured[0].params).toEqual(['2026-09-01', '2026-09-27']);
  });

  it('sumByDaySupportsOpenEndedRange', async () => {
    const { repo, captured } = makeCaptureDb();
    await repo.sumByDay('2026-09-01', undefined);
    expect(captured[0].params).toEqual(['2026-09-01']);

    await repo.sumByDay(undefined, '2026-09-27');
    expect(captured[1].params).toEqual(['2026-09-27']);
  });

  it('listMessageIdsBySessionReadsCamelCaseKey', async () => {
    const { repo } = makeCaptureDb();
    // db 返回行键为 camelCase（messageId）；若实现误读 snake 键将得到 NaN
    await expect(repo.listMessageIdsBySession(7)).resolves.toEqual([42]);
  });

  it('listDetailsJoinsWithPaginationParams', async () => {
    const { repo, captured } = makeCaptureDb();
    await repo.listDetails({ reason: 'OTHER', offset: 20, limit: 10 });
    const { sql, params } = captured[0];
    expect(sql).toContain('LEFT JOIN user u');
    expect(sql).toContain('LEFT JOIN agent a');
    expect(sql).toContain('LEFT JOIN message m');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(params).toEqual(['OTHER', 10, 20]);
  });

  it('upsertWritesSourceAndOverridesItOnDuplicate', async () => {
    const { repo, captured } = makeCaptureDb();
    await repo.upsert(11, 5, 9, 2, 'NO_REASON', 'feishu');
    const { sql, params } = captured[0];
    expect(sql).toContain('source');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE reason = VALUES(reason), source = VALUES(source)');
    expect(params).toEqual([11, 5, 9, 2, 'NO_REASON', 'feishu']);
  });

  it('upsertDefaultsSourceToDesktop', async () => {
    const { repo, captured } = makeCaptureDb();
    await repo.upsert(11, 5, 9, 2, 'WRONG_RESULT');
    expect(captured[0].params).toEqual([11, 5, 9, 2, 'WRONG_RESULT', 'desktop']);
  });

  it('existsByMessageIdReadsRowExistence', async () => {
    const { repo, captured } = makeCaptureDb();
    await expect(repo.existsByMessageId(11)).resolves.toBe(true);
    expect(captured[0].sql).toContain('SELECT id FROM message_feedback WHERE message_id = ?');
    expect(captured[0].params).toEqual([11]);
  });

  it('deleteByMessageIdDeletesAllRowsForTheMessage', async () => {
    const { repo, captured } = makeCaptureDb();
    await expect(repo.deleteByMessageId(11)).resolves.toBe(true);
    expect(captured[0].sql).toBe('DELETE FROM message_feedback WHERE message_id = ?');
    expect(captured[0].params).toEqual([11]);
  });

  it('listDetailsMapsSourceColumn', async () => {
    const { repo } = makeCaptureDb();
    const rows = await repo.listDetails({ offset: 0, limit: 10 });
    expect(rows[0]).toMatchObject({ source: 'feishu', reason: 'NO_REASON', contentPreview: 'hello' });
  });
});

/**
 * 内存 fake：实现 `uk_message(message_id)` 唯一键与 ON DUPLICATE KEY UPDATE 覆盖语义
 * （与 V123 建表一致）。纯 vi.fn() mock 触达不到唯一键，无法钉住「同一条消息只有一行」。
 */
function makeUniqueKeyDb() {
  const rows = new Map<number, { messageId: number; reason: string; source: string }>();
  return {
    rows,
    db: {
      execute: async (sql: string, params: unknown[]) => {
        if (/^INSERT INTO message_feedback/.test(sql)) {
          const [messageId, , , , reason, source] = params as [number, number, number, number, string, string];
          // 唯一键冲突 → 整行覆盖（MySQL ON DUPLICATE KEY UPDATE 的实际行为）
          rows.set(messageId, { messageId, reason, source });
          return { affectedRows: 1 };
        }
        if (/^DELETE FROM message_feedback WHERE message_id = \?$/.test(sql)) {
          return { affectedRows: rows.delete(params[0] as number) ? 1 : 0 };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      queryOne: async (sql: string, params: unknown[]) => {
        if (/SELECT id FROM message_feedback WHERE message_id = \? LIMIT 1/.test(sql)) {
          return rows.has(params[0] as number) ? { id: 1 } : null;
        }
        return null;
      },
    } as never,
  };
}

describe('FeedbackRepository 唯一键语义', () => {
  it('同一条消息只有一个 feedback 行：跨来源写入覆盖而非并存', async () => {
    // 桌面点踩过的消息再被飞书点踩：uk_message(message_id) 决定只会剩一行，且 source/reason 被覆盖。
    // toggle 的删除分支正是靠这一点判定「已点踩」，此处锁住该前提，防止有人给唯一键加 source 后失配。
    const { rows, db } = makeUniqueKeyDb();
    const repo = new FeedbackRepository(db);
    await repo.upsert(11, 5, 9, 2, 'WRONG_RESULT', 'desktop');
    expect(rows.size).toBe(1);
    expect(rows.get(11)).toMatchObject({ reason: 'WRONG_RESULT', source: 'desktop' });

    await repo.upsert(11, 5, 9, 2, 'NO_REASON', 'feishu');
    expect(rows.size).toBe(1);
    expect(rows.get(11)).toMatchObject({ reason: 'NO_REASON', source: 'feishu' });
  });

  it('existsByMessageId 与 deleteByMessageId 均按 message_id 判定，不区分来源', async () => {
    const { rows, db } = makeUniqueKeyDb();
    const repo = new FeedbackRepository(db);
    await expect(repo.existsByMessageId(11)).resolves.toBe(false);
    await repo.upsert(11, 5, 9, 2, 'WRONG_RESULT', 'desktop');
    await expect(repo.existsByMessageId(11)).resolves.toBe(true);
    await expect(repo.deleteByMessageId(11)).resolves.toBe(true);
    await expect(repo.existsByMessageId(11)).resolves.toBe(false);
    await expect(repo.deleteByMessageId(11)).resolves.toBe(false);
  });
});
