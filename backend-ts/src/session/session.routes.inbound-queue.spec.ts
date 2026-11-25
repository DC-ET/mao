import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { handleError } from '../common/http-error.js';
import { registerSessionRoutes } from './session.routes.js';
import type { SessionService } from './session.service.js';
import type { FeishuInboundQueueViewPort } from '../feishu/types.js';

/** 只覆盖飞书入站排队两个接口的最小装配（其余 deps 在注册期未被访问）。 */
function buildApp(view?: FeishuInboundQueueViewPort) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _reply, done) => {
    req.userId = 7;
    done();
  });
  const sessionService = {
    getSession: vi.fn(async (id: number) => (
      id === 1
        ? { id: 1, userId: 7, agentId: 9, status: 'ACTIVE', phase: 'RUNNING' }
        : { id, userId: 99, agentId: 9, status: 'ACTIVE', phase: 'IDLE' }
    )),
  } as unknown as SessionService;
  registerSessionRoutes(fastify, {
    sessionService,
    activityService: {} as never,
    todoRepo: {} as never,
    messageQueueService: { listPending: vi.fn(async () => []) } as never,
    pathSandbox: {} as never,
    subagentExecutionRepo: {} as never,
    sessionCompactionEventService: {} as never,
    sessionCompactionService: {} as never,
    runTraceService: {} as never,
    runTraceRecordService: {} as never,
    agentLookup: {} as never,
    modelLookup: {} as never,
    feishuInboundQueueView: view,
  });
  return fastify;
}

function view(overrides: Partial<FeishuInboundQueueViewPort> = {}): FeishuInboundQueueViewPort {
  return {
    list: vi.fn(async () => ({
      runningChannel: 'feishu' as const,
      lastRunFailed: false,
      items: [{
        id: '799', senderLabel: '杨佳毅', summary: '压测链路需求', imageCount: 0, fileCount: 0,
        createdAt: '2026-11-25 14:08:02', queuePosition: 1, cancelable: true,
      }],
    })),
    cancel: vi.fn(async () => 'CANCELLED' as const),
    ...overrides,
  };
}

describe('feishu inbound queue routes', () => {
  it('GET returns items from the view for the session owner', async () => {
    const inboundView = view();
    const app = buildApp(inboundView);
    const resp = await app.inject({ method: 'GET', url: '/v1/sessions/1/inbound-queue' });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.code).toBe(0);
    expect(body.data.runningChannel).toBe('feishu');
    expect(body.data.items[0].id).toBe('799');
    expect(inboundView.list).toHaveBeenCalledWith({ id: 1, userId: 7, phase: 'RUNNING' }, 7);
  });

  it('GET returns an empty payload when the view is not wired', async () => {
    const app = buildApp(undefined);
    const resp = await app.inject({ method: 'GET', url: '/v1/sessions/1/inbound-queue' });
    expect(resp.statusCode).toBe(200);
    // toJacksonJson 省略 null 字段（与 Jackson NON_NULL 一致），只断言可观察结构。
    expect(resp.json().data).toMatchObject({ lastRunFailed: false, items: [] });
  });

  it('GET rejects non-owner sessions', async () => {
    const app = buildApp(view());
    const resp = await app.inject({ method: 'GET', url: '/v1/sessions/2/inbound-queue' });
    expect(resp.statusCode).toBe(403);
  });

  it('DELETE returns 200 + result CANCELLED', async () => {
    const inboundView = view();
    const app = buildApp(inboundView);
    const resp = await app.inject({ method: 'DELETE', url: '/v1/sessions/1/inbound-queue/799' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({ code: 0, data: { result: 'CANCELLED' } });
    expect(inboundView.cancel).toHaveBeenCalledWith({ id: 1, userId: 7 }, 799, 7);
  });

  it('DELETE maps ALREADY_STARTED / NOT_FOUND to 200 + result', async () => {
    for (const result of ['ALREADY_STARTED', 'NOT_FOUND'] as const) {
      const app = buildApp(view({ cancel: vi.fn(async () => result) }));
      const resp = await app.inject({ method: 'DELETE', url: '/v1/sessions/1/inbound-queue/799' });
      expect(resp.statusCode).toBe(200);
      expect(resp.json().data.result).toBe(result);
    }
  });

  it('DELETE returns NOT_FOUND when the view is not wired', async () => {
    const app = buildApp(undefined);
    const resp = await app.inject({ method: 'DELETE', url: '/v1/sessions/1/inbound-queue/799' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().data.result).toBe('NOT_FOUND');
  });

  it('DELETE surfaces FORBIDDEN as HTTP 403', async () => {
    const app = buildApp(view({
      cancel: vi.fn(async () => { throw new BusinessException(ErrorCode.FORBIDDEN, '仅消息发送者可操作'); }),
    }));
    const resp = await app.inject({ method: 'DELETE', url: '/v1/sessions/1/inbound-queue/799' });
    expect(resp.statusCode).toBe(403);
  });

  it('DELETE rejects non-owner sessions before touching the view', async () => {
    const inboundView = view();
    const app = buildApp(inboundView);
    const resp = await app.inject({ method: 'DELETE', url: '/v1/sessions/2/inbound-queue/799' });
    expect(resp.statusCode).toBe(403);
    expect(inboundView.cancel).not.toHaveBeenCalled();
  });
});
