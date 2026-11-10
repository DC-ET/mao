import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerLlmUsageAdminRoutes } from './llm-usage-admin.routes.js';
import type { LlmCallService, MyUsageSummary, MyUsageTrends } from './llm-call.service.js';

/**
 * 管理后台「用户用量」路由（用户详情抽屉"用量"Tab 数据源）。
 * 服务层用 stub 捕获入参——summaryForUser/trendsForUser 的业务行为
 * 已由 llm-call.service.spec / llm-call.repository.spec 覆盖，这里只锁
 * 路由层的权限、归属校验与参数解析（方案 §10 测试要点）。
 */
function buildApp(opts: { permissions?: string[]; users?: number[] } = {}) {
  const permissions = opts.permissions ?? ['analytics:read'];
  const users = new Set(opts.users ?? [7]);
  const summaryForUser = vi.fn(async (): Promise<MyUsageSummary> => ({
    range: 'last30',
    window: { startYmd: '2025-12-12', endYmd: '2026-01-10' },
    totals: { callCount: 0, successCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
    byModel: [],
    byScene: [],
    byAgent: [],
  }));
  const trendsForUser = vi.fn(async (): Promise<MyUsageTrends> => ({
    range: 'last30',
    granularity: 'day',
    window: { startYmd: '2025-12-12', endYmd: '2026-01-10' },
    buckets: [],
  }));
  const llmCallService = { summaryForUser, trendsForUser } as unknown as LlmCallService;
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (request, _reply, done) => {
    request.userId = 9;
    done();
  });
  registerLlmUsageAdminRoutes(app, {
    llmCallService,
    permissionService: { hasPermission: vi.fn(async (_userId: number, code: string) => permissions.includes(code)) },
    userLookup: { findById: async (id: number) => (users.has(id) ? { id } : null) },
  });
  return { app, summaryForUser, trendsForUser };
}

describe('admin user usage routes', () => {
  it('无 analytics:read 返回 403，不触达服务层', async () => {
    const { app, summaryForUser } = buildApp({ permissions: [] });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary' });
    expect(res.statusCode).toBe(403);
    expect(summaryForUser).not.toHaveBeenCalled();
  });

  it('目标用户不存在返回 USER_NOT_FOUND，不触达服务层', async () => {
    const { app, summaryForUser } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/users/42/usage/summary' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number };
    expect(body.code).not.toBe(0);
    expect(summaryForUser).not.toHaveBeenCalled();
  });

  it(':id 非数字返回 PARAM_INVALID', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/users/abc/usage/summary' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).not.toBe(0);
    expect(body.message).toContain('用户 ID');
  });

  it('summary 透传解析后的周期与自定义区间；非法 range 回落 last30', async () => {
    const { app, summaryForUser } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary?range=last7' });
    expect(res.statusCode).toBe(200);
    expect(summaryForUser).toHaveBeenCalledWith(7, 'last7', undefined);

    await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary?range=hack' });
    expect(summaryForUser).toHaveBeenLastCalledWith(7, 'last30', undefined);
  });

  it('custom 起止倒置交换（同 me/* 语义），非法格式回落缺省窗口', async () => {
    const { app, summaryForUser } = buildApp();
    await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary?range=custom&startDate=2026-01-10&endDate=2026-01-01' });
    expect(summaryForUser).toHaveBeenLastCalledWith(7, 'custom', { startDate: '2026-01-01', endDate: '2026-01-10' });

    await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary?range=custom&startDate=not-a-date&endDate=2026-01-10' });
    expect(summaryForUser).toHaveBeenLastCalledWith(7, 'custom', undefined);
  });

  it('custom 跨度超 365 天返回 PARAM_INVALID；恰好 365 天放行', async () => {
    const { app, summaryForUser } = buildApp();
    // 2025-01-01 ~ 2026-01-01 = 366 天 → 拒绝
    const tooLong = await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary?range=custom&startDate=2025-01-01&endDate=2026-01-01' });
    expect(tooLong.statusCode).toBe(200);
    const body = JSON.parse(tooLong.body) as { code: number; message: string };
    expect(body.code).not.toBe(0);
    expect(body.message).toContain('365');
    expect(summaryForUser).not.toHaveBeenCalled();

    // 2025-01-01 ~ 2025-12-31 = 365 天 → 放行
    await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/summary?range=custom&startDate=2025-01-01&endDate=2025-12-31' });
    expect(summaryForUser).toHaveBeenLastCalledWith(7, 'custom', { startDate: '2025-01-01', endDate: '2025-12-31' });
  });

  it('trends 复用同一 resolveTargetUser：目标用户不存在同样不触达服务层', async () => {
    const { app, trendsForUser } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/users/42/usage/trends' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number };
    expect(body.code).not.toBe(0);
    expect(trendsForUser).not.toHaveBeenCalled();
  });

  it('trends 透传粒度白名单：hour 保留、其余回落 day', async () => {
    const { app, trendsForUser } = buildApp();
    await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/trends?range=today&granularity=hour' });
    expect(trendsForUser).toHaveBeenLastCalledWith(7, 'today', 'hour', undefined);

    await app.inject({ method: 'GET', url: '/v1/admin/users/7/usage/trends?granularity=week' });
    expect(trendsForUser).toHaveBeenLastCalledWith(7, 'last30', 'day', undefined);
  });
});
