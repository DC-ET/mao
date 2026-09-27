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
  };
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/FROM message_feedback f\s+WHERE.*GROUP BY reason/s.test(sql)) return rowsByCall.group;
      if (/SELECT message_id FROM message_feedback/s.test(sql)) return rowsByCall.ids;
      return [];
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/FROM message_feedback f/.test(sql)) return rowsByCall.count[0];
      return null;
    }),
    execute: vi.fn(),
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
});
