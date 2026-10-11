import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerFeedbackRoutes, type FeedbackRouteDeps } from './feedback.routes.js';
import type { FeedbackService } from './feedback.service.js';
import type { ExperienceDraftService } from './experience-draft.service.js';
import type { JwtService } from '../crypto/jwt.service.js';

/**
 * 管理端点与权限拆分测试：mock 掉 service，只验证路由的权限码、参数解析与透传。
 * 403 的口径是 BusinessException(403) → handleError 转成 HTTP 403 + code=1002。
 */

const FEEDBACK_WRITE = 'feedback:write';
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
    buildDraftContext: vi.fn(async (...args: unknown[]) => {
      (calls.buildDraftContext ??= []).push(args);
      return { materials: [{ reason: 'WRONG_RESULT', reasonLabel: '结果错误', messageId: 1, userText: 'u', assistantText: 'a', traceText: 't' }], snapshotAgentId: 3 };
    }),
    convertToExperience: vi.fn(async (...args: unknown[]) => {
      (calls.convertToExperience ??= []).push(args);
      return { experienceId: 42 };
    }),
    dismiss: vi.fn(async (...args: unknown[]) => {
      (calls.dismiss ??= []).push(args);
      return { updated: args[1]?.length ?? 0 };
    }),
  };
  const experienceDraft = {
    draft: vi.fn(async (...args: unknown[]) => {
      (calls.draft ??= []).push(args);
      return { experiences: [{ content: '经验内容' }] };
    }),
  };
  return {
    deps: {
      jwt: {} as JwtService,
      feedback: feedback as unknown as FeedbackService,
      experienceDraft: experienceDraft as unknown as ExperienceDraftService,
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

  it('draft 未传 agentId 时回落反馈行快照 agent_id', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/draft',
      payload: { feedbackIds: [1] },
    }));
    expect(response.code).toBe(0);
    expect(response.data).toEqual({ experiences: [{ content: '经验内容' }] });
    // buildDraftContext 先取原料与快照，draft 再用快照 agentId 调模型
    expect(calls.buildDraftContext[0][0]).toEqual([1]);
    expect(calls.draft[0]).toEqual([7, 3, expect.any(Array)]);
    await fastify.close();
  });

  it('draft 显式 agentId 优先于快照', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/draft',
      payload: { feedbackIds: [1, 2], agentId: 8 },
    }));
    expect(response.code).toBe(0);
    expect(calls.draft[0]).toEqual([7, 8, expect.any(Array)]);
    await fastify.close();
  });

  it('draft 空 feedbackIds 直接拒绝，不调 service', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/draft',
      payload: { feedbackIds: [] },
    }));
    expect(response.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(calls.buildDraftContext).toBeUndefined();
    await fastify.close();
  });

  it('convert 缺 agentId 拒绝；合法请求透传 experiences', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const missing = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/convert',
      payload: { feedbackIds: [1], experiences: [{ content: 'x' }] },
    }));
    expect(missing.code).toBe(ErrorCode.PARAM_INVALID.code);

    const ok1 = json(await fastify.inject({
      method: 'POST',
      url: '/v1/feedback/admin/convert',
      payload: {
        feedbackIds: [1, 2],
        agentId: 5,
        experiences: [{ content: '第一条', sortOrder: 0 }, { content: '第二条' }],
      },
    }));
    expect(ok1.code).toBe(0);
    expect(ok1.data).toEqual({ experienceId: 42 });
    expect(calls.convertToExperience[0][0]).toBe(7);
    expect(calls.convertToExperience[0][1]).toEqual({
      feedbackIds: [1, 2],
      agentId: 5,
      experiences: [{ content: '第一条', sortOrder: 0 }, { content: '第二条', sortOrder: undefined }],
    });
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

  it('feedback:read 可读 list/summary，但不能写 draft/convert/dismiss', async () => {
    const { deps, calls } = makeDeps({
      permissionService: { hasPermission: vi.fn(async (_u: number, code: string) => code === FEEDBACK_READ) },
    });
    const fastify = await app(deps);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/list' })).code).toBe(0);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/feedback/admin/summary' })).code).toBe(0);
    const draft = json(await fastify.inject({ method: 'POST', url: '/v1/feedback/admin/draft', payload: { feedbackIds: [1] } }));
    expect(draft.code).toBe(1002);
    const convert = json(await fastify.inject({
      method: 'POST', url: '/v1/feedback/admin/convert',
      payload: { feedbackIds: [1], agentId: 1, experiences: [{ content: 'x' }] },
    }));
    expect(convert.code).toBe(1002);
    const dismiss = json(await fastify.inject({ method: 'POST', url: '/v1/feedback/admin/dismiss', payload: { feedbackIds: [1] } }));
    expect(dismiss.code).toBe(1002);
    // 三个写端点都不能触达 service
    expect(calls.buildDraftContext).toBeUndefined();
    expect(calls.convertToExperience).toBeUndefined();
    expect(calls.dismiss).toBeUndefined();
    await fastify.close();
  });

  it('无权限时四个管理端点全部 403', async () => {
    const { deps, calls } = makeDeps({
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const fastify = await app(deps);
    for (const [method, url, payload] of [
      ['GET', '/v1/feedback/admin/list', undefined],
      ['GET', '/v1/feedback/admin/summary', undefined],
      ['POST', '/v1/feedback/admin/draft', { feedbackIds: [1] }],
      ['POST', '/v1/feedback/admin/convert', { feedbackIds: [1], agentId: 1, experiences: [{ content: 'x' }] }],
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
        convertToExperience: vi.fn(async () => { throw new (await import('../common/business-exception.js')).BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED); }),
      } as unknown as FeedbackService,
    });
    const fastify = await app(deps);
    const response = await fastify.inject({
      method: 'POST', url: '/v1/feedback/admin/convert',
      payload: { feedbackIds: [1], agentId: 1, experiences: [{ content: 'x' }] },
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
