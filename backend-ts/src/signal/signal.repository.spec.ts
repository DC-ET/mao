import { describe, expect, it, vi } from 'vitest';
import { MysqlSignalWatcherRepository, MysqlSignalCheckRepository } from './signal.repository.js';

/**
 * 仓储 SQL 语义回归。
 *
 * 这些断言针对真实 MySQL 行为（第 3 轮 BUG-I / BUG-G）：
 * - BUG-I：`status = IF(consecutive_failures + 1 >= 5, ...)` 在 MySQL 里因为 SET 从左到右
 *   求值，实际第 4 次失败就停用；必须用累加后的当前值与阈值比。
 * - BUG-G：`markChecked` 不能无条件写 0，否则会打回探针在途期间并发累加的失败计数。
 * - 时钟口径（2026-11-07 review）：失败退避与成功路径一样用 Node 时钟算好参数传库
 *   （`last_checked_at = ?`），不再 `DATE_ADD(NOW(), INTERVAL ? MINUTE)`——DB 会话时区
 *   与应用时区不一致时，DB 钟与 listDue 的 Node 钟混用会让退避整体漂移。
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
    // 参数顺序：backoffUntil（Node 钟算出的退避时刻）, threshold, id
    expect(update!.params[1]).toBe(5);
    expect(update!.params[2]).toBe(1);
  });

  it('WHERE 仍限定 status = ACTIVE（PAUSED 不被误停用）', async () => {
    const h = capture();
    await h.repo.recordFailure(1, 30, 5).catch(() => undefined);
    const update = h.calls.find((c) => c.sql.includes('consecutive_failures = consecutive_failures + 1'));
    expect(update!.sql).toContain("WHERE id = ? AND status = 'ACTIVE'");
  });

  it('退避时刻用 Node 时钟算好传参，不再混用 DATE_ADD(NOW())', async () => {
    const h = capture();
    await h.repo.recordFailure(1, 30, 5).catch(() => undefined);
    const update = h.calls.find((c) => c.sql.includes('consecutive_failures = consecutive_failures + 1'));
    expect(update).toBeDefined();
    // SQL 侧不再出现 MySQL 时钟：DB 会话时区 ≠ 应用时区时退避会整体漂移
    expect(update!.sql).not.toMatch(/NOW\(\)|DATE_ADD|INTERVAL/i);
    expect(update!.sql).toContain('last_checked_at = ?');
    // 参数是 Node 钟 + backoffMinutes 算出的未来时刻（上海时区格式化，与成功路径同源）
    const parsed = Date.parse(String(update!.params[0]).replace(' ', 'T') + '+08:00');
    expect(Number.isNaN(parsed)).toBe(false);
    expect(Math.abs(parsed - (Date.now() + 30 * 60_000))).toBeLessThan(3000);
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
    expect(update!.sql).toContain('consecutive_failures = IF(? = 0, consecutive_failures, IF(consecutive_failures = ?, 0, consecutive_failures))');
    // 参数顺序：hash, snippet, changedAt, lastCheckedAt(now), resetFlag(默认 1), 本次读到的失败数, id
    expect(update!.params[0]).toBe('abc');
    expect(update!.params[1]).toBe('OLD');
    expect(update!.params[4]).toBe(1);
    expect(update!.params[5]).toBe(0);
    expect(update!.params[6]).toBe(1);
  });

  it('resetFailures=false 时不写清零条件（触发失败路径要接着 +1）', async () => {
    const h = capture();
    await h.repo.markChecked(1, {
      lastValueHash: 'abc',
      lastValueSnippet: null,
      lastChangedAt: null,
      consecutiveFailures: 3,
      resetFailures: false,
    });
    const update = h.calls.find((c) => c.sql.includes('last_value_hash = ?'));
    expect(update!.params[4]).toBe(0);
    expect(update!.params[5]).toBe(3);
  });

  it('update 可以清空 last_checked_at（重新启用时清退避）', async () => {
    const h = capture();
    await h.repo.update(1, 7, { status: 'ACTIVE', lastCheckedAt: null, consecutiveFailures: 0 });
    const update = h.calls.find((c) => c.sql.includes('UPDATE signal_watcher SET'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('last_checked_at = ?');
    expect(update!.params).toContain(null);
  });

  it('update 补上 lastValueSnippet 映射：基线重置的 null 必须落库（§5.7 存量缺陷）', async () => {
    const h = capture();
    await h.repo.update(1, 7, { lastValueHash: null, lastValueSnippet: null, lastChangeOldSnippet: null, lastChangeNewSnippet: null });
    const update = h.calls.find((c) => c.sql.includes('UPDATE signal_watcher SET'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('last_value_snippet = ?');
    expect(update!.sql).toContain('last_change_old_snippet = ?');
    expect(update!.sql).toContain('last_change_new_snippet = ?');
    expect(update!.params).toContain(null);
    // 未下发 lastValueSnippet 时不得出现该列（缺省 = 不动）
    const h2 = capture();
    await h2.repo.update(1, 7, { lastCheckedAt: null });
    const update2 = h2.calls.find((c) => c.sql.includes('UPDATE signal_watcher SET'));
    expect(update2!.sql).not.toContain('last_value_snippet');
  });

  it('markChecked 带 lastChange* 键时才写两列（缺省行为逐字不变）', async () => {
    const withPair = capture();
    await withPair.repo.markChecked(1, {
      lastValueHash: 'h',
      lastValueSnippet: 'NEW',
      lastChangedAt: '2026-11-04 00:00:00',
      consecutiveFailures: 0,
      lastChangeOldSnippet: 'OLD',
      lastChangeNewSnippet: 'NEW',
    });
    const update = withPair.calls.find((c) => c.sql.includes('last_value_hash = ?'));
    expect(update!.sql).toContain('last_change_old_snippet = ?');
    expect(update!.sql).toContain('last_change_new_snippet = ?');
    // 参数：hash, snippet, changedAt, now, resetFlag, failures, old, new, id
    expect(update!.params).toEqual(['h', 'NEW', '2026-11-04 00:00:00', expect.any(String), 1, 0, 'OLD', 'NEW', 1]);

    const withoutPair = capture();
    await withoutPair.repo.markChecked(1, {
      lastValueHash: 'h',
      lastValueSnippet: 'NEW',
      lastChangedAt: null,
      consecutiveFailures: 0,
    });
    const plain = withoutPair.calls.find((c) => c.sql.includes('last_value_hash = ?'));
    expect(plain!.sql).not.toContain('last_change_old_snippet');
    expect(plain!.params).toHaveLength(7);
  });

  it('updateValue 一次 UPDATE 写哈希 + 新旧片段', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      execute: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { affectedRows: 1, insertId: 0 };
      }),
    };
    const repo = new MysqlSignalCheckRepository(db as never);
    await repo.updateValue(9, { valueHash: 'hh', oldValueSnippet: 'O', newValueSnippet: 'N' });
    const update = calls.find((c) => c.sql.includes('UPDATE signal_watcher_check SET'));
    expect(update).toBeDefined();
    expect(update!.sql).toBe('UPDATE signal_watcher_check SET value_hash = ?, old_value_snippet = ?, new_value_snippet = ? WHERE id = ?');
    expect(update!.params).toEqual(['hh', 'O', 'N', 9]);
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
