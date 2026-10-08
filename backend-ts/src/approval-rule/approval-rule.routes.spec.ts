import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerApprovalRuleRoutes } from './approval-rule.routes.js';
import { ApprovalRuleService } from './approval-rule.service.js';
import type { ApprovalRuleRow } from './types.js';

function row(overrides: Partial<ApprovalRuleRow>): ApprovalRuleRow {
  return {
    id: 1,
    userId: 7,
    scope: 'USER',
    sessionId: null,
    ruleType: 'SHELL_PREFIX',
    ruleValue: 'npm run',
    hitCount: 0,
    lastHitAt: null,
    enabled: 1,
    createdAt: '2026-10-07 10:00:00',
    updatedAt: '2026-10-07 10:00:00',
    ...overrides,
  };
}

/** 25 条混合类型规则，按 hit_count 降序（与 listByUser 的 ORDER BY 一致）：MCP 规则 hit 最低，落在第 2 页。 */
function mixedRules(): ApprovalRuleRow[] {
  const rows: ApprovalRuleRow[] = [];
  for (let i = 1; i <= 20; i++) {
    rows.push(row({ id: i, ruleType: 'SHELL_PREFIX', ruleValue: `cmd${i}`, hitCount: 100 - i }));
  }
  for (let i = 21; i <= 25; i++) {
    rows.push(row({ id: i, ruleType: 'MCP_TOOL', ruleValue: `mcp__s__t${i}`, hitCount: 1 }));
  }
  return rows;
}

function buildApp(rows: ApprovalRuleRow[]) {
  const repo = {
    listByUser: vi.fn(async (_uid: number, _scope: string | null, ruleType: string | null, limit: number, offset: number) => {
      const sorted = rows.slice().sort((a, b) => b.hitCount - a.hitCount || b.id - a.id);
      const filtered = ruleType == null ? sorted : sorted.filter((r) => r.ruleType === ruleType);
      return filtered.slice(offset, offset + limit);
    }),
    countByUser: vi.fn(async (_uid: number, _scope: string | null, ruleType: string | null) =>
      (ruleType == null ? rows : rows.filter((r) => r.ruleType === ruleType)).length),
    listEnabledForMatch: vi.fn(async () => rows),
    insert: vi.fn(async () => 999),
    findById: vi.fn(async () => null),
    findBySessionAndValue: vi.fn(async () => null),
    updateEnabled: vi.fn(async () => undefined),
    updateValue: vi.fn(async () => undefined),
    deleteById: vi.fn(async () => undefined),
    incrementHit: vi.fn(async () => undefined),
    pageAdmin: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 20 })),
  };
  const service = new ApprovalRuleService(
    repo as never,
    { getValue: vi.fn(async () => '') },
    { getUserId: vi.fn(async () => 7) },
  );
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
  registerApprovalRuleRoutes(app, { approvalRuleService: service });
  return app;
}

describe('approval rule routes', () => {
  it('listIsPagedServerSideAndFiltersRuleType', async () => {
    const app = buildApp(mixedRules());
    try {
      const page1 = JSON.parse((await app.inject({ method: 'GET', url: '/v1/approval-rules?page=1&pageSize=20' })).body);
      // 第 1 页只有 SHELL_PREFIX：前端若只取一页再本地按类型筛选，选「MCP 工具」tab 会看不到任何规则
      expect(page1.data.total).toBe(25);
      expect(page1.data.records).toHaveLength(20);
      expect(page1.data.records.every((r: { ruleType: string }) => r.ruleType === 'SHELL_PREFIX')).toBe(true);

      const page2 = JSON.parse((await app.inject({ method: 'GET', url: '/v1/approval-rules?page=2&pageSize=20' })).body);
      expect(page2.data.records.every((r: { ruleType: string }) => r.ruleType === 'MCP_TOOL')).toBe(true);

      // 修复后：ruleType 服务端过滤，第 1 页即目标类型，total 与 tab 口径一致
      const withType = JSON.parse((await app.inject({ method: 'GET', url: '/v1/approval-rules?ruleType=MCP_TOOL' })).body);
      expect(withType.data.total).toBe(5);
      expect(withType.data.records).toHaveLength(5);
      expect(withType.data.records.every((r: { ruleType: string }) => r.ruleType === 'MCP_TOOL')).toBe(true);

      // 越界类型值视为不过滤（与 scope 的宽松口径一致）
      const invalid = JSON.parse((await app.inject({ method: 'GET', url: '/v1/approval-rules?ruleType=BOGUS' })).body);
      expect(invalid.data.total).toBe(25);
      expect(invalid.data.records).toHaveLength(20);
    } finally {
      await app.close();
    }
  });

  it('createNormalizesAndReturnsRuleValue', async () => {
    const saved = row({ id: 42, ruleType: 'SHELL_PREFIX', ruleValue: 'git push' });
    const repo = {
      listByUser: vi.fn(async () => []),
      countByUser: vi.fn(async () => 0),
      listEnabledForMatch: vi.fn(async () => []),
      insert: vi.fn(async () => 42),
      findById: vi.fn(async () => saved),
      findBySessionAndValue: vi.fn(async () => null),
      updateEnabled: vi.fn(async () => undefined),
      updateValue: vi.fn(async () => undefined),
      deleteById: vi.fn(async () => undefined),
      incrementHit: vi.fn(async () => undefined),
      pageAdmin: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 20 })),
    };
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    registerApprovalRuleRoutes(app, {
      approvalRuleService: new ApprovalRuleService(
        repo as never,
        { getValue: vi.fn(async () => '') },
        { getUserId: vi.fn(async () => 7) },
      ),
    });
    try {
      const created = JSON.parse((await app.inject({
        method: 'POST',
        url: '/v1/approval-rules',
        payload: { ruleType: 'SHELL_PREFIX', ruleValue: 'git push origin main' },
      })).body);
      expect(created.data.ruleValue).toBe('git push');
      expect(repo.insert).toHaveBeenCalledWith({ userId: 7, scope: 'USER', sessionId: null, ruleType: 'SHELL_PREFIX', ruleValue: 'git push' });

      const denied = JSON.parse((await app.inject({
        method: 'POST',
        url: '/v1/approval-rules',
        payload: { ruleType: 'SHELL_EXACT', ruleValue: 'rm -rf x' },
      })).body);
      expect(denied.code).toBe(3038);
    } finally {
      await app.close();
    }
  });

  it('patchAndDeleteOtherUsersRuleReturns404', async () => {
    const app = buildApp([]);
    try {
      const patched = await app.inject({ method: 'PATCH', url: '/v1/approval-rules/1', payload: { enabled: false } });
      // findById 在 buildApp 中返回 null → 视为不存在
      expect(JSON.parse(patched.body).code).toBe(3037);
      const deleted = await app.inject({ method: 'DELETE', url: '/v1/approval-rules/1' });
      expect(JSON.parse(deleted.body).code).toBe(3037);
    } finally {
      await app.close();
    }
  });
});
