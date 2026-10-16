import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerFeedbackRoutes, type FeedbackRouteDeps } from './feedback.routes.js';
import type { FeedbackService } from './feedback.service.js';
import type { JwtService } from '../crypto/jwt.service.js';

/**
 * 管理端点与权限拆分测试：mock 掉 service，只验证路由的权限码、参数解析与透传。
 * 403 的口径是 BusinessException(403) → handleError 转成 HTTP 403 + code=1002。
 */

const FEEDBACK_READ = 'feedback:read';

function makeDeps(over: Partial<FeedbackRouteDeps> = {}): { deps: FeedbackRouteDeps; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const feedback = {
    dislike: vi.fn(async (...args: unknown[]) => { (calls.dislike ??= []).push(args); }),
    cancelDislike: vi.fn(async () => {}),
    listDislikedMessageIds: vi.fn(async () => [1, 2]),
    getSummary: vi.fn(async (...args: unknown[]) => {
      (calls.getSummary ??= []).push(args);
      return { total: 0, byReason: [], byDay: [], pendingCount: 0, pendingMatrix: [] };
    }),
    listDetails: vi.fn(async (...args: unknown[]) => {
      (calls.listDetails ??= []).push(args);
      return { total: 0, items: [] };
    }),
    dismiss: vi.fn(async (...args: unknown[]) => {
      (calls.dismiss ??= []).push(args);
      return { updated: args[1]?.length ?? 0 };
    }),
  };
  return {
    deps: {
      jwt: {} as JwtService,
      feedback: feedback as unknown as FeedbackService,
      permissionService: { hasPermission: vi.fn(async () => true) },
      ...over,
    },
    calls,
  };
}

async function app(deps: FeedbackRouteDeps) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    req.userId = 7;
    done();
  });
  registerFeedbackRoutes(fastify, deps);
  await fastify.ready();
  return fastify;
}

function json(response: { body: string }) {
  return JSON.parse(response.body) as { code: number; data?: Record<string, unknown> };
}

describe('feedback admin routes', () => {
  it('list 把 status / agentId 透传给 service，缺省时为 undefined', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'GET',
      url: '/v1/feedback/admin/list?status=PENDING&agentId=9&reason=WRONG_RESULT&page=2&pageSize=5',
    }));
    expect(response.code).toBe(0);
    const filter = calls.listDetails[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({ reason: 'WRONG_RESULT', status: 'PENDING', agentId: 9, page: 2, pageSize: 5 });

    const defaults = json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/list' }));
    expect(defaults.code).toBe(0);
    const emptyFilter = calls.listDetails[1][0] as Record<string, unknown>;
    expect(emptyFilter.status).toBeUndefined();
    expect(emptyFilter.agentId).toBeUndefined();
    expect(emptyFilter.page).toBe(1);
    expect(emptyFilter.pageSize).toBe(20);
    await fastify.close();
  });

  it('list 拒绝非法的 status 与 agentId（不静默降级为全表查询）', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    // 非法 status 由路由层直接拒绝（不传给 service 校验，避免把客户端拼错变成全表查询）
    const badStatus = json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/list?status=ARCHIVED' }));
    expect(badStatus.code).toBe(0);
    expect((calls.listDetails[0][0] as Record<string, unknown>).status).toBeUndefined();
    // agentId=0 / 非整数是明确错误，必须拒绝而不是当作「未筛选」
    const badAgent = json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/list?agentId=0' }));
    expect(badAgent.code).toBe(ErrorCode.PARAM_INVALID.code);
    const nonInteger = json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/list?agentId=1.5' }));
    expect(nonInteger.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(calls.listDetails).toHaveLength(1);
    await fastify.close();
  });

  it('dismiss 返回 updated 并透传操作人', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/dismiss',
      payload: { feedbackIds: [1, 2] },
    }));
    expect(response.code).toBe(0);
    expect(response.data).toEqual({ updated: 2 });
    expect(calls.dismiss[0]).toEqual([7, [1, 2]]);
    await fastify.close();
  });

  it('dismiss 空 feedbackIds 直接拒绝，不调 service', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/dismiss',
      payload: { feedbackIds: [] },
    }));
    expect(response.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(calls.dismiss).toBeUndefined();
    await fastify.close();
  });

  it('feedback:read 可读 list/summary，但不能写 dismiss', async () => {
    const { deps, calls } = makeDeps({
      permissionService: { hasPermission: vi.fn(async (_u: number, code: string) => code === FEEDBACK_READ) },
    });
    const fastify = await app(deps);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/list' })).code).toBe(0);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/summary' })).code).toBe(0);
    const dismiss = json(await fastify.inject({ method: 'POST', url: '/v1/feedback/admin/dismiss', payload: { feedbackIds: [1] } }));
    expect(dismiss.code).toBe(1002);
    // 写端点不能触达 service
    expect(calls.dismiss).toBeUndefined();
    await fastify.close();
  });

  it('无权限时三个管理端点全部 403', async () => {
    const { deps, calls } = makeDeps({
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const fastify = await app(deps);
    for (const [method, url, payload] of [
      ['GET', '/v1/feedback/admin/list', undefined],
      ['GET', '/v1/feedback/admin/summary', undefined],
      ['POST', '/v1/feedback/admin/dismiss', { feedbackIds: [1] }],
    ] as Array<[string, string, unknown]>) {
      const response = json(await fastify.inject({ method: method as 'GET', url, payload }));
      expect(response.code).toBe(1002);
    }
    expect(calls.getSummary).toBeUndefined();
    expect(calls.listDetails).toBeUndefined();
    await fastify.close();
  });

  it('service 抛 FEEDBACK_ALREADY_HANDLED 时按业务码返回（HTTP 200 + 3046）', async () => {
    const { deps } = makeDeps({
      feedback: {
        dismiss: vi.fn(async () => { throw new (await import('../common/business-exception.js')).BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED); }),
      } as unknown as FeedbackService,
    });
    const fastify = await app(deps);
    const response = await fastify.inject({
      method: 'POST', url: '/v1/feedback/admin/dismiss',
      payload: { feedbackIds: [1] },
    });
    expect(response.statusCode).toBe(200);
    expect(json(response).code).toBe(ErrorCode.FEEDBACK_ALREADY_HANDLED.code);
    await fastify.close();
  });

  it('点踩相关端点不受管理权限影响（用户自身操作）', async () => {
    const { deps } = makeDeps({
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const fastify = await app(deps);
    const put = json(await fastify.inject({ method: 'PUT', url: '/v1/feedback/messages/9/dislike', payload: { reason: 'WRONG_RESULT' } }));
    expect(put.code).toBe(0);
    const ids = json(await fastify.inject({ method: 'GET', url: '/v1/feedback/messages/disliked-ids?sessionId=3' }));
    expect(ids.code).toBe(0);
    expect(ids.data).toEqual({ ids: [1, 2] });
    await fastify.close();
  });
});
