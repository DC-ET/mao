import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMcpServerRoutes, type McpServerRouteDeps } from './mcp-server.routes.js';
import { BusinessException } from '../../../common/business-exception.js';

function buildApp(overrides: Partial<McpServerRouteDeps> = {}) {
  const app: FastifyInstance = Fastify();
  app.addHook('onRequest', async (request) => {
    (request as unknown as { userId: number }).userId = 7;
  });
  // create-app 由全局错误处理器把 BusinessException 转成 Result；这里用最小等价实现。
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BusinessException) {
      void reply.status(200).send({ code: error.code, message: error.message, data: null });
      return;
    }
    void reply.status(500).send({ code: 500, message: error.message, data: null });
  });
  const deps: McpServerRouteDeps = {
    mcpServerService: {
      listEnabled: vi.fn(async () => []),
      listMine: vi.fn(async () => []),
      validatePreferenceTarget: vi.fn(async () => undefined),
    } as never,
    mcpClientManager: {} as never,
    userMcpPreferenceService: {
      getDisabledServerIds: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
    } as never,
    userMcpLoadModeService: { save: vi.fn(async () => undefined) } as never,
    mcpLoadModeResolver: {
      resolve: vi.fn(async () => 'working_set'),
      invalidate: vi.fn(),
    } as never,
    permissionService: { hasPermission: vi.fn(async () => true) } as never,
    ...overrides,
  };
  registerMcpServerRoutes(app, deps);
  return { app, deps };
}

describe('MCP load-mode routes', () => {
  it('GET returns the effective mode in the API spelling', async () => {
    const { app, deps } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/mcp-servers/load-mode' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ code: 0, data: { loadMode: 'WORKING_SET' } });
    expect((deps.mcpLoadModeResolver as unknown as { resolve: ReturnType<typeof vi.fn> }).resolve).toHaveBeenCalledWith(7);
    await app.close();
  });

  it('PUT saves the user preference and invalidates the resolver cache', async () => {
    const { app, deps } = buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/v1/mcp-servers/load-mode',
      payload: { loadMode: 'FULL' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({ loadMode: 'FULL' });
    expect((deps.userMcpLoadModeService as unknown as { save: ReturnType<typeof vi.fn> }).save)
      .toHaveBeenCalledWith(7, 'full');
    expect((deps.mcpLoadModeResolver as unknown as { invalidate: ReturnType<typeof vi.fn> }).invalidate)
      .toHaveBeenCalledWith(7);
    await app.close();
  });

  it('PUT rejects unknown modes with PARAM_INVALID', async () => {
    const { app, deps } = buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/v1/mcp-servers/load-mode',
      payload: { loadMode: 'HALF' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(2001);
    expect(body.message).toContain('WORKING_SET');
    expect((deps.userMcpLoadModeService as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not shadow the existing preferences route', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/mcp-servers/preferences' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    const loadMode = await app.inject({ method: 'GET', url: '/v1/mcp-servers/load-mode' });
    expect(JSON.parse(loadMode.body).data.loadMode).toBe('WORKING_SET');
    await app.close();
  });
});
