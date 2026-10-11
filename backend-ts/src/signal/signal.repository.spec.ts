import { describe, expect, it, vi } from 'vitest';
import { MysqlSignalWatcherRepository } from './signal.repository.js';

/**
 * 仓储 SQL 语义回归。
 *
 * 这些断言针对真实 MySQL 行为（第 3 轮 BUG-I / BUG-G）：
 * - BUG-I：`status = IF(consecutive_failures + 1 >= 5, ...)` 在 MySQL 里因为 SET 从左到右
 *   求值，实际第 4 次失败就停用；必须用累加后的当前值与阈值比。
 * - BUG-G：`markChecked` 不能无条件写 0，否则会打回探针在途期间并发累加的失败计数。
 *
 * 不连库，只断言发出的 SQL 与参数——这正是真实执行时求值的那一条语句。
 */

function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    queryOne: vi.fn(async () => ({ c: 1 })),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [];
    }),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { affectedRows: 1, insertId: 0 };
    }),
  };
  const repo = new MysqlSignalWatcherRepository(db as never);
  return { repo, calls };
}

describe('recordFailure 停用阈值（BUG-I 回归）', () => {
  it('status 判定用累加后的当前值，不再 +1（否则第 4 次就停用）', async () => {
    const h = capture();
    // findById 复读：返回一行，供断言调用链完整
    h.calls.length = 0;
    await h.repo.recordFailure(1, 30, 5).catch(() => undefined);
    const update = h.calls.find((c) => c.sql.includes('consecutive_failures = consecutive_failures + 1'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("status = IF(consecutive_failures >= ?, 'DISABLED', status)");
    expect(update!.sql).not.toContain('consecutive_failures + 1 >=');
    // 参数顺序：backoffMinutes, threshold, id
    expect(update!.params).toEqual([30, 5, 1]);
  });

  it('WHERE 仍限定 status = ACTIVE（PAUSED 不被误停用）', async () => {
    const h = capture();
    await h.repo.recordFailure(1, 30, 5).catch(() => undefined);
    const update = h.calls.find((c) => c.sql.includes('consecutive_failures = consecutive_failures + 1'));
    expect(update!.sql).toContain("WHERE id = ? AND status = 'ACTIVE'");
  });
});

describe('markChecked 失败计数条件清零（BUG-G 回归）', () => {
  it('仅在库内值等于本次读到的值时才写 0', async () => {
    const h = capture();
    await h.repo.markChecked(1, {
      lastValueHash: 'abc',
      lastValueSnippet: 'OLD',
      lastChangedAt: null,
      consecutiveFailures: 0,
    });
    const update = h.calls.find((c) => c.sql.includes('last_value_hash = ?'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('consecutive_failures = IF(consecutive_failures = ?, 0, consecutive_failures)');
    // 参数顺序：hash, snippet, changedAt, lastCheckedAt(now), 本次读到的失败数, id
    expect(update!.params[0]).toBe('abc');
    expect(update!.params[1]).toBe('OLD');
    expect(update!.params[4]).toBe(0);
    expect(update!.params[5]).toBe(1);
  });

  it('不再无条件覆盖（LEAST 取小等价于恒写 0，已废弃）', async () => {
    const h = capture();
    await h.repo.markChecked(1, {
      lastValueHash: 'abc',
      lastValueSnippet: null,
      lastChangedAt: null,
      consecutiveFailures: 0,
    });
    const update = h.calls.find((c) => c.sql.includes('last_value_hash = ?'));
    expect(update!.sql).not.toContain('LEAST(');
  });
});
