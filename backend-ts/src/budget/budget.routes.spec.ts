import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerBudgetRoutes } from './budget.routes.js';
import type { BudgetService } from './budget.service.js';

describe('budget routes', () => {
  function build(granted: string[]) {
    const hasPermission = vi.fn(async (_userId: number, code: string) => granted.includes(code));
    const list = vi.fn(async () => [{ id: 1, scope: 'GLOBAL', limitType: 'COST', limitValue: 100_000_000, action: 'BLOCK', enabled: 1 }]);
    const create = vi.fn(async (input: Record<string, unknown>) => ({ id: 42, ...input }));
    const update = vi.fn(async (id: number, input: Record<string, unknown>) => ({ id, ...input }));
    const remove = vi.fn(async () => undefined);
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    registerBudgetRoutes(app, {
      budgetService: { list, create, update, remove } as unknown as BudgetService,
      permissionService: { hasPermission },
    });
    return { app, hasPermission, list, create, update, remove };
  }

  it('budget:read 缺失 → 403，且不触达 service', async () => {
    const h = build(['budget:write']);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/budgets' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe(1002); // FORBIDDEN
    expect(h.list).not.toHaveBeenCalled();
    expect(h.hasPermission).toHaveBeenCalledWith(7, 'budget:read');
  });

  it('budget:read 通过 → 200 列表', async () => {
    const h = build(['budget:read']);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/budgets' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it('写操作（POST/PUT/DELETE）缺 budget:write → 403，零副作用', async () => {
    const h = build(['budget:read']);
    for (const req of [
      { method: 'POST', url: '/v1/admin/budgets', payload: { scope: 'GLOBAL', limitType: 'COST', limitValue: 1, action: 'WARN' } },
      { method: 'PUT', url: '/v1/admin/budgets/3', payload: { scope: 'GLOBAL', limitType: 'COST', limitValue: 1, action: 'WARN' } },
      { method: 'DELETE', url: '/v1/admin/budgets/3' },
    ]) {
      const res = await h.app.inject(req);
      expect(res.statusCode, req.method).toBe(403);
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('POST 透传字段并记录 createdBy=当前用户', async () => {
    const h = build(['budget:write']);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/admin/budgets',
      payload: { scope: 'USER', scopeId: 5, limitType: 'COST', limitValue: 1_000_000, action: 'BLOCK', enabled: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(h.create).toHaveBeenCalledWith({
      scope: 'USER', scopeId: 5, limitType: 'COST', limitValue: 1_000_000, action: 'BLOCK', enabled: 0, createdBy: 7,
    });
  });

  it('POST 缺字段归一为空串/0（交由 service 校验拒绝）', async () => {
    const h = build(['budget:write']);
    await h.app.inject({ method: 'POST', url: '/v1/admin/budgets', payload: {} });
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ scope: '', limitType: '', limitValue: 0, action: '' }));
  });

  it('PUT / DELETE 按路径 id 转发', async () => {
    const h = build(['budget:write']);
    await h.app.inject({ method: 'PUT', url: '/v1/admin/budgets/9', payload: { scope: 'GLOBAL', limitType: 'TOKENS', limitValue: 10, action: 'WARN', enabled: 1 } });
    expect(h.update).toHaveBeenCalledWith(9, { scope: 'GLOBAL', scopeId: null, limitType: 'TOKENS', limitValue: 10, action: 'WARN', enabled: 1 });
    const del = await h.app.inject({ method: 'DELETE', url: '/v1/admin/budgets/9' });
    expect(del.statusCode).toBe(200);
    expect(h.remove).toHaveBeenCalledWith(9);
  });

  it('未认证请求 → 401（requireUserId 前置）', async () => {
    const h = build(['budget:read']);
    const app = Fastify();
    app.setErrorHandler(handleError);
    registerBudgetRoutes(app, { budgetService: { list: h.list } as unknown as BudgetService, permissionService: { hasPermission: h.hasPermission } });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/budgets' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.list).not.toHaveBeenCalled();
  });
});
