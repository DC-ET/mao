import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAdminAnalyticsRoutes } from './admin.routes.js';

const RUN_TRACE_PAYLOAD = {
  period: {},
  scene: 'agent',
  scope: 'agent',
  slowestRounds: [],
  mostExpensiveRounds: [],
  toolFailureRates: [],
};

async function app(runTraceScope = vi.fn(async () => RUN_TRACE_PAYLOAD)) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    (req as unknown as { userId: number }).userId = 7;
    done();
  });
  registerAdminAnalyticsRoutes(fastify, {
    jwt: {} as never,
    analytics: { runTraceScope } as never,
    userRepo: {} as never,
    permissionService: { hasPermission: vi.fn(async () => true) },
  } as never);
  return { fastify, runTraceScope };
}

describe('admin analytics run-trace route', () => {
  it('reads scene / scope exactly as the admin UI and mao-cli send them', async () => {
    const { fastify, runTraceScope } = await app();

    // 管理后台 AnalyticsView.currentQuery() 只发 scene + scope（缺省 agent/agent）
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace?days=7&scene=agent&scope=user' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    expect(runTraceScope).toHaveBeenCalledWith(7, 0, { scene: 'agent', scope: 'user', limit: 20 });

    // 不传时回落到 scene=agent / scope=agent
    vi.mocked(runTraceScope).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace' });
    expect(runTraceScope).toHaveBeenCalledWith(30, 0, { scene: 'agent', scope: 'agent', limit: 20 });

    // scope 只认 user，其余值回落 agent，不把任意字符串透给服务端
    vi.mocked(runTraceScope).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace?scope=whatever' });
    expect(runTraceScope).toHaveBeenCalledWith(30, 0, { scene: 'agent', scope: 'agent', limit: 20 });

    await fastify.close();
  });

  it('requires analytics:read', async () => {
    const runTraceScope = vi.fn(async () => RUN_TRACE_PAYLOAD);
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    registerAdminAnalyticsRoutes(fastify, {
      jwt: {} as never,
      analytics: { runTraceScope } as never,
      userRepo: {} as never,
      permissionService: { hasPermission: vi.fn(async () => false) },
    } as never);
    const denied = await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace' });
    expect(denied.statusCode).toBe(403);
    expect(runTraceScope).not.toHaveBeenCalled();
    await fastify.close();
  });
});
