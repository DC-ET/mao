import { describe, expect, it } from 'vitest';
import type { Db } from '../db/db.js';
import { toCamel } from '../common/case.js';
import { MysqlWebhookTriggerRepository } from './openapi.repository.js';

const DISABLE_AFTER = 5;
const NOW = '2026-10-05 12:00:00';

interface TriggerRow {
  consecutiveFailures: number;
  enabled: number;
  lastFiredAt: string | null;
}

/**
 * 忠实建模 InnoDB 行锁 + autocommit + Db 层 camelCase 转换的最小内存 fake：
 * - 每条语句耗时恰好一个微任务，使并发交错确定可复现；
 * - 非事务路径的 `SELECT … FOR UPDATE`：行锁随语句结束即释放（autocommit 语义）；
 * - `transaction()`：单连接视图，行锁保持到 commit / rollback 才释放；
 * - 结果行按 snake_case 列名存储、读出前统一过 `toCamel`——与 `Db.queryOne`
 *   （db.ts → toCamelList）的契约一致，访问方必须按 camelCase 键读列。
 *
 * 因此「读-改-写包进事务」与「两条语句各取连接」、以及「按 snake_case 键读列」
 * 在这个 fake 上行为都可被区分：前者并发两次 FAILED 会读到同一快照互相覆盖，
 * 后者字段恒为 undefined。
 */
function makeFakeDb(initial: TriggerRow, options: { missing?: boolean } = {}) {
  // 内部以数据库列名（snake_case）存储
  const columns = {
    consecutive_failures: initial.consecutiveFailures,
    enabled: initial.enabled,
    last_fired_at: initial.lastFiredAt,
  };
  const sql: string[] = [];
  const locks = new Set<number>();
  let waiters: Array<() => void> = [];

  const hop = (): Promise<void> => Promise.resolve();

  async function acquire(id: number): Promise<void> {
    while (locks.has(id)) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    locks.add(id);
  }

  function release(id: number): void {
    locks.delete(id);
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  }

  /** 读出路径与真实 Db 一致：snake_case 列名 → camelCase 键。 */
  function read(): { consecutiveFailures: number; enabled: number } | null {
    if (options.missing) return null;
    return toCamel({ consecutive_failures: columns.consecutive_failures, enabled: columns.enabled });
  }

  function apply(sqlText: string, params: unknown[]): void {
    sql.push(sqlText);
    if (params.length >= 4) {
      columns.consecutive_failures = Number(params[0]);
      columns.enabled = Number(params[1]);
      columns.last_fired_at = String(params[2]);
      return;
    }
    if (sqlText.includes('consecutive_failures = 0')) {
      columns.consecutive_failures = 0;
    }
    columns.last_fired_at = String(params[0]);
  }

  const db = {
    queryOne: async (sqlText: string, params: unknown[] = []) => {
      await hop();
      const id = Number(params[0]);
      if (!sqlText.includes('FOR UPDATE')) return null;
      await acquire(id);
      const snapshot = read();
      release(id); // autocommit：锁随本语句结束释放
      return snapshot;
    },
    execute: async (sqlText: string, params: unknown[] = []) => {
      await hop();
      apply(sqlText, params);
      return undefined as never;
    },
    transaction: async <T,>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const held: number[] = [];
      const tx = {
        queryOne: async (sqlText: string, params: unknown[] = []) => {
          await hop();
          if (!sqlText.includes('FOR UPDATE')) return null;
          const id = Number(params[0]);
          await acquire(id);
          held.push(id);
          return read();
        },
        execute: async (sqlText: string, params: unknown[] = []) => {
          await hop();
          apply(sqlText, params);
          return undefined as never;
        },
      };
      try {
        return await fn(tx as unknown as Db);
      } finally {
        for (const id of held) release(id);
      }
    },
  };

  return {
    db: db as unknown as Db,
    // 断言用活视图：随写入实时反映 camelCase 列值
    row: {
      get consecutiveFailures() { return columns.consecutive_failures; },
      get enabled() { return columns.enabled; },
      get lastFiredAt() { return columns.last_fired_at; },
    },
    sql,
  };
}

describe('MysqlWebhookTriggerRepository.recordOutcome', () => {
  it('FAILED 逐次累加，达到阈值即停用并回报 disabled', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 3, enabled: 1, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    expect(await repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW)).toEqual({ consecutiveFailures: 4, disabled: false });
    expect(await repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW)).toEqual({ consecutiveFailures: 5, disabled: true });
    expect(fake.row).toMatchObject({ consecutiveFailures: 5, enabled: 0, lastFiredAt: NOW });
  });

  it('COMPLETED 清零并刷新 last_fired_at', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 4, enabled: 1, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    expect(await repo.recordOutcome(1, 'COMPLETED', DISABLE_AFTER, NOW)).toEqual({ consecutiveFailures: 0, disabled: false });
    expect(fake.row).toMatchObject({ consecutiveFailures: 0, enabled: 1, lastFiredAt: NOW });
  });

  it('已停用的触发器不再累加：只刷 last_fired_at（停用态不被迟到回写改写）', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 5, enabled: 0, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    expect(await repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW)).toBeNull();
    expect(fake.row).toMatchObject({ consecutiveFailures: 5, enabled: 0, lastFiredAt: NOW });
  });

  it('行已删除：返回 null 且无计数副作用', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 2, enabled: 1, lastFiredAt: null }, { missing: true });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    expect(await repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW)).toBeNull();
    expect(fake.row).toMatchObject({ consecutiveFailures: 2, enabled: 1 });
  });

  it('BUG-3 回归：从压线值 4 起单次 FAILED 必须读到 5 并停用（结果键按 camelCase 读）', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 4, enabled: 1, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    expect(await repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW)).toEqual({ consecutiveFailures: 5, disabled: true });
    expect(fake.row).toMatchObject({ consecutiveFailures: 5, enabled: 0, lastFiredAt: NOW });
  });

  it('CANCELLED 不计不清不写库（决策 11）', async () => {    const fake = makeFakeDb({ consecutiveFailures: 2, enabled: 1, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    expect(await repo.recordOutcome(1, 'CANCELLED', DISABLE_AFTER, NOW)).toBeNull();
    expect(fake.sql).toHaveLength(0);
    expect(fake.row).toMatchObject({ consecutiveFailures: 2, enabled: 1, lastFiredAt: null });
  });

  it('BUG-2 回归：并发 FAILED 回写不丢计数（读-改-写事务内完成，行锁保持到提交）', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 0, enabled: 1, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    const [first, second] = await Promise.all([
      repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW),
      repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW),
    ]);
    expect(fake.row.consecutiveFailures).toBe(2);
    expect([first, second].map((r) => r?.consecutiveFailures).sort()).toEqual([1, 2]);
  });

  it('BUG-2 回归：并发 FAILED 恰好压线阈值时只停用一次（另一路读到已停用不再计数）', async () => {
    const fake = makeFakeDb({ consecutiveFailures: 4, enabled: 1, lastFiredAt: null });
    const repo = new MysqlWebhookTriggerRepository(fake.db);
    const [first, second] = await Promise.all([
      repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW),
      repo.recordOutcome(1, 'FAILED', DISABLE_AFTER, NOW),
    ]);
    // 一路压线停用（5），另一路读到 enabled=0 只刷 last_fired，不越阈值
    expect(fake.row).toMatchObject({ consecutiveFailures: 5, enabled: 0 });
    expect([first, second].filter((r) => r != null)).toHaveLength(1);
    expect(first?.consecutiveFailures ?? second?.consecutiveFailures).toBe(5);
  });
});
