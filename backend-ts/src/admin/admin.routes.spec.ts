import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('admin analytics range param', () => {
  // 只 fake Date：shanghaiYmd() 走系统时钟，固定到 2026-10-29（周四）中午让窗口断言稳定
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T04:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function overviewApp() {
    const overview = vi.fn(async () => ({ period: {} }));
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    registerAdminAnalyticsRoutes(fastify, {
      jwt: {} as never,
      analytics: { overview } as never,
      userRepo: {} as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
    } as never);
    return { fastify, overview };
  }

  it('日历周期解析成 (days, endOffset) 交给服务端窗口计算', async () => {
    const { fastify, overview } = await overviewApp();

    // 本周 = 周一 10-26 起 4 天；上周 = 10-19 ~ 10-25；本月 = 1 日至今 29 天；上月 = 9 月整月
    for (const [query, expected] of [
      ['range=week', [4, 0]],
      ['range=lastWeek', [7, 10]],
      ['range=month', [29, 0]],
      ['range=lastMonth', [30, 29]],
      ['range=today', [1, 0]],
      ['range=yesterday', [1, 1]],
    ] as const) {
      vi.mocked(overview).mockClear();
      const res = await fastify.inject({ method: 'GET', url: `/v1/admin/analytics/overview?${query}` });
      expect(res.statusCode, query).toBe(200);
      expect(vi.mocked(overview).mock.calls[0].slice(0, 2), query).toEqual(expected);
    }

    await fastify.close();
  });

  it('自定义区间按下发起止日换算，缺日期回落默认 30 天', async () => {
    const { fastify, overview } = await overviewApp();

    await fastify.inject({
      method: 'GET',
      url: '/v1/admin/analytics/overview?range=custom&start=2026-10-01&end=2026-10-15',
    });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([15, 14]);

    // 半截区间（前端两个日期必填，这里防直接调用）→ 回落默认窗口
    vi.mocked(overview).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/overview?range=custom&start=2026-10-01' });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([30, 0]);

    await fastify.close();
  });

  it('不传 range 时仍按 days/endOffset 取数（mao-cli 兼容）', async () => {
    const { fastify, overview } = await overviewApp();

    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/overview?days=7&endOffset=1' });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([7, 1]);

    // range 与 days 同时给时语义周期优先
    vi.mocked(overview).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/overview?range=week&days=7' });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([4, 0]);

    await fastify.close();
  });
});
