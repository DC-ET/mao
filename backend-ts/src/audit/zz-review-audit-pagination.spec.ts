import { describe, expect, it, vi } from 'vitest';
import { MysqlAuditLogRepository } from './audit.repository.js';
import type { AuditLog } from './types.js';

/**
 * 逻辑 BUG 验证（review 探针，非产品用例）：
 * audit_log.created_at 是秒级 DATETIME（V048），同一秒并发写多行时
 * ORDER BY created_at DESC 不是全序，MySQL 对并列行返回顺序不保证稳定，
 * 深翻页会出现重复行/丢行（审计留痕在分页列表里静默丢失）。
 * 对照：session.repository / llm-call.repository 都带了唯一 tiebreaker（, id DESC）。
 */

function mockDb(rows: AuditLog[], total = rows.length) {
  return {
    query: vi.fn(async () => rows),
    queryOne: vi.fn(async () => ({ cnt: total })),
    insert: vi.fn(async () => 1),
    execute: vi.fn(async () => ({ affectedRows: 1, insertId: 1 })),
  };
}

const row = (id: number, createdAt = '2026-10-12 10:00:00'): AuditLog =>
  ({ id, userId: 1, username: 'admin', action: 'UPDATE', objectType: 'model', objectId: '1', method: 'PUT', path: '/api/v1/models/1', queryString: null, ip: '127.0.0.1', status: 200, success: 1, errorMessage: null, createdAt }) as AuditLog;

describe('review: audit 分页排序键必须唯一', () => {
  it('selectPage 的 ORDER BY 必须带唯一 tiebreaker（当前只有 created_at DESC）', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
    const db = mockDb(rows);
    const repo = new MysqlAuditLogRepository(db as never);

    await repo.selectPage(1, 20, {});

    const sql = String(db.query.mock.calls[0]![0]);
    expect(sql).toMatch(/ORDER BY created_at DESC, id DESC/);
  });

  it('秒级并列 created_at 下翻页并集必须恰好覆盖全部行（模拟 MySQL 两种并列顺序）', async () => {
    // 25 行全部同一秒；page1 按 id 升序返回并列行，page2 按 id 降序——并列顺序不稳定时
    // 无唯一排序键的深翻页会重复/丢行
    const all = Array.from({ length: 25 }, (_, i) => row(i + 1));
    const page1 = all.slice(0, 20);
    const page2Unstable = [...all.slice(0, 20)].reverse().concat(all.slice(20));
    const db = mockDb(page1);
    db.query
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2Unstable);
    const repo = new MysqlAuditLogRepository(db as never);

    const p1 = await repo.selectPage(1, 20, {});
    const p2 = await repo.selectPage(2, 20, {});
    const ids = [...p1.records, ...p2.records].map((r) => r.id);
    // 有唯一排序键时 MySQL 不会出现第二种并列顺序，两页并集恒为 25；
    // 当前实现无法保证 → 该断言在稳定排序修复前视为已知风险点
    expect(new Set(ids).size).toBe(25);
  });
});
