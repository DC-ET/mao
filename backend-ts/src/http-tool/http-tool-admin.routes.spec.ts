import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerAdminHttpToolRoutes } from './http-tool-admin.routes.js';
import type { HttpToolService } from './http-tool.service.js';
import type { HttpToolDraft, ResolvedHttpToolExecution } from './types.js';

/** stub service：记录 test / create 的入参，返回最小合法形态。 */
function stubService() {
  const service = {
    resolveDraftForExecution: vi.fn(
      async (draft: HttpToolDraft, toolId?: number): Promise<ResolvedHttpToolExecution> => ({
        tool: {
          name: draft.name,
          displayName: draft.displayName,
          method: draft.method ?? 'GET',
          url: draft.url,
          headers: { Authorization: 'Bearer real-from-stored' },
          bodyTemplate: null,
          timeoutMs: 15000,
        },
        params: [],
      }),
    ),
    create: vi.fn(async () => ({ id: 1, name: 'weather' })),
  };
  return service;
}

function buildApp(options: { hasPermission?: boolean } = {}) {
  const service = stubService();
  const httpApiExecutor = {
    execute: vi.fn(async () => ({ status: 200, body: 'ok', truncated: false, displayName: '天气查询' })),
  };
  const permissionService = { hasPermission: vi.fn(async () => options.hasPermission ?? true) };
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
  registerAdminHttpToolRoutes(app, {
    service: service as unknown as HttpToolService,
    stats: { selectHttpToolCallStats: vi.fn(async () => []) },
    httpApiExecutor: httpApiExecutor as never,
    permissionService,
  });
  return { app, service, httpApiExecutor, permissionService };
}

const draftBody = {
  name: 'weather',
  displayName: '天气查询',
  description: '查询城市天气',
  method: 'GET',
  url: 'https://api.example.com/v1/weather',
};

describe('admin http-tool routes — test endpoint toolId', () => {
  it('passes toolId through to resolveDraftForExecution', async () => {
    const { app, service } = buildApp();
    try {
      const resp = await app.inject({
        method: 'POST',
        url: '/v1/admin/http-tools/test',
        payload: { ...draftBody, headers: [{ key: 'Authorization', value: '******' }], toolId: 3 },
      });
      expect(resp.statusCode).toBe(200);
      expect(service.resolveDraftForExecution).toHaveBeenCalledTimes(1);
      const [, toolId] = service.resolveDraftForExecution.mock.calls[0]!;
      expect(toolId).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('omits toolId when the body does not carry one', async () => {
    const { app, service } = buildApp();
    try {
      const resp = await app.inject({ method: 'POST', url: '/v1/admin/http-tools/test', payload: draftBody });
      expect(resp.statusCode).toBe(200);
      const [, toolId] = service.resolveDraftForExecution.mock.calls[0]!;
      expect(toolId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects non-positive-integer toolId with PARAM_INVALID', async () => {
    const { app, service } = buildApp();
    try {
      for (const toolId of [0, -1, 'abc', 1.5]) {
        const resp = await app.inject({
          method: 'POST',
          url: '/v1/admin/http-tools/test',
          payload: { ...draftBody, toolId },
        });
        const body = JSON.parse(resp.body);
        // 业务参数错误：HTTP 200 + envelope code（与全仓 fail 口径一致）
        expect(body.code, `toolId=${String(toolId)}`).toBe(ErrorCode.PARAM_INVALID.code);
        expect(body.message).toBe('toolId 无效');
      }
      expect(service.resolveDraftForExecution).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('test response keeps carrying only status/body and never headers', async () => {
    const { app } = buildApp();
    try {
      const resp = await app.inject({
        method: 'POST',
        url: '/v1/admin/http-tools/test',
        payload: { ...draftBody, toolId: 3 },
      });
      const data = JSON.parse(resp.body).data;
      expect(data).toMatchObject({ status: 200, body: 'ok' });
      expect(JSON.stringify(data)).not.toContain('Bearer real-from-stored');
    } finally {
      await app.close();
    }
  });
});

describe('admin http-tool routes — create endpoint copyFromId', () => {
  it('passes copyFromId through in the draft', async () => {
    const { app, service } = buildApp();
    try {
      const resp = await app.inject({
        method: 'POST',
        url: '/v1/admin/http-tools',
        payload: { ...draftBody, copyFromId: 5 },
      });
      expect(resp.statusCode).toBe(200);
      const [draft] = service.create.mock.calls[0]!;
      expect(draft.copyFromId).toBe(5);
    } finally {
      await app.close();
    }
  });

  it('omits copyFromId when not provided', async () => {
    const { app, service } = buildApp();
    try {
      await app.inject({ method: 'POST', url: '/v1/admin/http-tools', payload: draftBody });
      const [draft] = service.create.mock.calls[0]!;
      expect(draft.copyFromId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects non-positive-integer copyFromId with PARAM_INVALID', async () => {
    const { app, service } = buildApp();
    try {
      for (const copyFromId of [0, 'abc', 2.5]) {
        const resp = await app.inject({
          method: 'POST',
          url: '/v1/admin/http-tools',
          payload: { ...draftBody, copyFromId },
        });
        const body = JSON.parse(resp.body);
        expect(body.code, `copyFromId=${String(copyFromId)}`).toBe(ErrorCode.PARAM_INVALID.code);
        expect(body.message).toBe('copyFromId 无效');
      }
      expect(service.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('admin http-tool routes — permission', () => {
  it('rejects write endpoints without http_tool:write', async () => {
    const { app } = buildApp({ hasPermission: false });
    try {
      const created = await app.inject({ method: 'POST', url: '/v1/admin/http-tools', payload: draftBody });
      expect(created.statusCode).toBe(403);
      const tested = await app.inject({ method: 'POST', url: '/v1/admin/http-tools/test', payload: draftBody });
      expect(tested.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
