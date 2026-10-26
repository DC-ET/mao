import { describe, expect, it, vi } from 'vitest';
import { BudgetRepository } from './budget.repository.js';

/**
 * listApplicableToUser 的 SQL 语义回归（用户面 GET /v1/me/budgets 的越权边界，C4）：
 * - 只取 enabled = 1 的行（停用行是管理噪音，不进用户面）；
 * - scope = 'GLOBAL' OR (scope = 'USER' AND scope_id = 本人)——他人 USER 行与 AGENT 行
 *   天然不可见，无需应用层再过滤；
 * - ORDER BY id ASC，service 侧再按 GLOBAL → USER 稳定重排。
 *
 * 不连库，只断言发出的 SQL 与参数——这正是真实执行时求值的那一条语句。
 */
function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    queryOne: vi.fn(async () => null),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [];
    }),
    execute: vi.fn(async () => ({ affectedRows: 0, insertId: 0 })),
  };
  const repo = new BudgetRepository(db as never);
  return { repo, calls };
}

describe('BudgetRepository.listApplicableToUser', () => {
  it('SQL：enabled=1 且 GLOBAL 或本人 USER 行；参数只有 userId；ORDER BY id ASC', async () => {
    const h = capture();
    await h.repo.listApplicableToUser(7);
    expect(h.calls).toHaveLength(1);
    const { sql, params } = h.calls[0];
    expect(sql).toContain('FROM usage_budget');
    expect(sql).toContain('enabled = 1');
    expect(sql).toContain("scope = 'GLOBAL' OR (scope = 'USER' AND scope_id = ?)");
    expect(sql).toContain('ORDER BY id ASC');
    expect(params).toEqual([7]);
  });

  it('返回行原样透出（不做应用层过滤，过滤全在 SQL）', async () => {
    const row = { id: 3, scope: 'USER', scopeId: 7, period: 'MONTHLY', limitType: 'COST', limitValue: 1, action: 'WARN', enabled: 1 };
    const db = {
      queryOne: vi.fn(async () => null),
      query: vi.fn(async () => [row]),
      execute: vi.fn(async () => ({ affectedRows: 0, insertId: 0 })),
    };
    const repo = new BudgetRepository(db as never);
    expect(await repo.listApplicableToUser(7)).toEqual([row]);
  });
});
