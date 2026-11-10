import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAdminSessionRoutes } from './admin-session.routes.js';
import type { Session } from './types.js';

function baseSession(): Session {
  return {
    id: 1, userId: 7, agentId: 9, title: 'hello', status: 'ACTIVE', phase: 'IDLE',
    executionMode: 'CLOUD', permissionLevel: 'FULL', workspace: '/tmp/ws', unread: 0,
  } as Session;
}

interface Harness {
  fastify: ReturnType<typeof Fastify>;
  recovery: { preview: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> };
  permissionService: { hasPermission: ReturnType<typeof vi.fn> };
}

function buildApp(opts: { canWrite: boolean } = { canWrite: true }): Harness {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    req.userId = 1;
    done();
  });
  const permissionService = {
    hasPermission: vi.fn(async (_userId: number, code: string) =>
      code === 'session:write' ? opts.canWrite : true),
  };
  const sessionService = {
    getSession: vi.fn(async () => baseSession()),
    deleteSession: vi.fn(),
    archiveSession: vi.fn(),
  };
  const recovery = {
    preview: vi.fn(async (windowHours: number) => ({
      windowHours, total: 1, recoverableCount: 1, truncated: false,
      items: [{ sessionId: 431, willRecover: true, skipReason: null }],
    })),
    run: vi.fn(async (sessionIds: number[]) => ({ accepted: sessionIds, skipped: [] })),
  };
  registerAdminSessionRoutes(fastify, {
    sessionService: sessionService as never,
    userLookup: { findByIds: vi.fn(), listOptions: vi.fn() } as never,
    agentLookup: { findByIds: vi.fn(), listOptions: vi.fn() } as never,
    modelLookup: { findById: vi.fn(), findByIds: vi.fn(), findDefault: vi.fn() } as never,
    permissionService,
    failedSessionRecovery: recovery,
  });
  return { fastify, recovery, permissionService };
}

describe('admin session recovery routes', () => {
  it('previewPassesWindowAndIgnoresLegacyScope', async () => {
    const { fastify, recovery } = buildApp();
    const res = await fastify.inject({
      method: 'GET',
      url: '/v1/admin/sessions/recover-failed/preview?windowHours=72&scope=ALL_402_403',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data.windowHours).toBe(72);
    expect(body.data.scope).toBeUndefined();
    expect(recovery.preview).toHaveBeenCalledWith(72);
  });

  it('previewClampsWindow', async () => {
    const { fastify, recovery } = buildApp();
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/recover-failed/preview?windowHours=999' });
    expect(res.statusCode).toBe(200);
    expect(recovery.preview).toHaveBeenCalledWith(168);
  });

  it('previewIgnoresUnknownScope', async () => {
    const { fastify, recovery } = buildApp();
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/recover-failed/preview?scope=EVERYTHING' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    expect(recovery.preview).toHaveBeenCalledWith(24);
  });

  it('previewRequiresSessionWrite', async () => {
    const { fastify } = buildApp({ canWrite: false });
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/recover-failed/preview' });
    expect(res.statusCode).toBe(403);
  });

  it('runDelegatesToService', async () => {
    const { fastify, recovery } = buildApp();
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/admin/sessions/recover-failed/run',
      payload: { sessionIds: [431, 473], scope: 'QUOTA' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ accepted: [431, 473], skipped: [] });
    expect(recovery.run).toHaveBeenCalledWith([431, 473]);
  });

  it('runValidatesSessionIdsShape', async () => {
    const { fastify } = buildApp();
    const notArray = await fastify.inject({
      method: 'POST', url: '/v1/admin/sessions/recover-failed/run', payload: { sessionIds: 431 },
    });
    expect(JSON.parse(notArray.body).code).toBe(2001);
    const notPositive = await fastify.inject({
      method: 'POST', url: '/v1/admin/sessions/recover-failed/run', payload: { sessionIds: [0, -1] },
    });
    expect(JSON.parse(notPositive.body).code).toBe(2001);
  });

  it('runRequiresSessionWrite', async () => {
    const { fastify } = buildApp({ canWrite: false });
    const res = await fastify.inject({
      method: 'POST', url: '/v1/admin/sessions/recover-failed/run', payload: { sessionIds: [431] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('routesAreStaticAndNotSwallowedByParamRoute', async () => {
    // /v1/admin/sessions/:id 与 recover-failed/* 同前缀：find-my-way 静态段优先，
    // 该用例防回归「新增静态路由被 :id 吞掉」。
    const { fastify } = buildApp();
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/recover-failed/preview' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveProperty('items');
  });
});

describe('admin session recovery routes without service injected', () => {
  function buildBareApp() {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 1;
      done();
    });
    const permissionService = { hasPermission: vi.fn(async () => true) };
    const sessionService = { getSession: vi.fn(async () => baseSession()) };
    registerAdminSessionRoutes(fastify, {
      sessionService: sessionService as never,
      userLookup: { findByIds: vi.fn(), listOptions: vi.fn() } as never,
      agentLookup: { findByIds: vi.fn(), listOptions: vi.fn() } as never,
      modelLookup: { findById: vi.fn(), findByIds: vi.fn(), findDefault: vi.fn() } as never,
      permissionService,
    });
    return fastify;
  }

  it('previewReturnsEmptyListWhenDisabled', async () => {
    const fastify = buildBareApp();
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/recover-failed/preview' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({
      windowHours: 24, total: 0, recoverableCount: 0, truncated: false, items: [],
    });
  });

  it('runFailsLoudlyWhenDisabled', async () => {
    const fastify = buildBareApp();
    const res = await fastify.inject({
      method: 'POST', url: '/v1/admin/sessions/recover-failed/run', payload: { sessionIds: [431] },
    });
    expect(JSON.parse(res.body).code).toBe(5001);
  });
});
