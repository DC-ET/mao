import { describe, expect, it, vi } from 'vitest';
import { MysqlSignalWatcherRepository } from './signal.repository.js';

/**
 * BUG：到期扫描 SQL 没有扣减 `interval_minutes`，用户配置的轮询间隔在成功路径上完全失效。
 *
 * 期望行为（技术方案 §5.3「`status='ACTIVE'` 且 `last_checked_at` 为空或早于
 * `NOW() - interval_minutes`」、CHANGELOG「按固定间隔探测（间隔 1~1440 分钟）」、
 * mao-cli 手册「按固定间隔由后端主动探测」）：
 *   刚成功轮询过的哨兵，在 interval_minutes 之内不得再次入队。
 *
 * 实际行为（signal.repository.ts `listDue`）：
 *   `WHERE status = 'ACTIVE' AND (last_checked_at IS NULL OR last_checked_at < ?)`，
 *   `?` 是原始当前时刻；而 `markChecked` 在成功路径把 `last_checked_at` 写成当前时刻。
 *   于是下一轮 30s 扫描时 `last_checked_at < now` 恒成立——**每个 ACTIVE 哨兵每 30 秒
 *   就被重新探针一次**，interval_minutes（默认 15，最大 1440）被彻底旁路；
 *   只有失败退避（`recordFailure` 写未来时刻）才能真正推迟下次探针。
 *
 * 已用本机 MySQL 8.0.46 实证（临时库，已 DROP）：interval=1440、1 小时前刚轮询过的哨兵，
 * 在 now='2026-10-14 10:00:00' 的扫描里依然被该 SQL 捞出；本 spec 不连库，
 * 只断言真实执行时求值的那一条语句（同 signal.repository.spec.ts 的方法论）。
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

describe('BUG：listDue 到期判定忽略 interval_minutes', () => {
  it('到期阈值必须按行扣减 interval_minutes（当前 SQL 只与原始 now 比较）', async () => {
    const h = capture();
    await h.repo.listDue('2026-10-14 10:00:00', 50);
    const scan = h.calls.find((c) => /FROM\s+signal_watcher\b/.test(c.sql));
    expect(scan).toBeDefined();
    console.log('listDue SQL =', scan!.sql.replace(/\s+/g, ' '));
    // 正确行为：due = last_checked_at 为空 或 last_checked_at < now - interval_minutes，
    // 例如 `last_checked_at < DATE_SUB(?, INTERVAL interval_minutes MINUTE)`。
    expect(
      scan!.sql,
      'listDue 必须按行的 interval_minutes 扣减到期阈值；当前 SQL 完全不引用 interval_minutes，' +
      '导致每个 ACTIVE 哨兵每 30s 扫描都被判为到期，间隔配置失效',
    ).toMatch(/interval_minutes/);
  });

  it('到期判定仍只扫 ACTIVE 行且批量上限受钳制（修复时不得破坏）', async () => {
    const h = capture();
    await h.repo.listDue('2026-10-14 10:00:00', 50);
    const scan = h.calls.find((c) => /FROM\s+signal_watcher\b/.test(c.sql));
    expect(scan!.sql).toContain("status = 'ACTIVE'");
    expect(scan!.sql).toContain('LIMIT 50');
    expect(scan!.params).toEqual(['2026-10-14 10:00:00']);
  });
});
