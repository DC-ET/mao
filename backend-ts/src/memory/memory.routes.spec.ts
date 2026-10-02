import Fastify from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { registerMemoryRoutes } from './memory.routes.js';
import { MemoryService } from './memory.service.js';
import type { MemoryRepository } from './memory.repository.js';
import type { MemoryService as MemoryServiceType } from './memory.service.js';
import type { MemoryItemVO } from './types.js';

function memoryItem(overrides: Partial<MemoryItemVO> = {}): MemoryItemVO {
  return {
    id: 1,
    scope: 'USER',
    projectKey: null,
    content: '输出报告用中文',
    source: 'MANUAL',
    status: 'ACTIVE',
    originSessionId: null,
    createdAt: '2026-10-02 10:00:00',
    updatedAt: '2026-10-02 10:00:00',
    ...overrides,
  };
}

describe('memory routes', () => {
  function buildApp(service: Partial<MemoryService>) {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    registerMemoryRoutes(fastify, { memoryService: service as MemoryServiceType });
    return fastify;
  }

  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    service = {
      list: vi.fn(async () => ({ records: [memoryItem()], total: 1, current: 1, size: 20 })),
      create: vi.fn(async () => memoryItem()),
      update: vi.fn(async () => memoryItem()),
      remove: vi.fn(async () => undefined),
      getAutoCaptureEnabled: vi.fn(async () => false),
      updateAutoCaptureEnabled: vi.fn(async () => false),
      listProjectKeys: vi.fn(async () => ['mao', 'web']),
    };
  });

  it('listReturnsPagedRecordsAndPassesFilters', async () => {
    const app = buildApp(service);
    const res = await app.inject({ method: 'GET', url: '/v1/memory?page=2&pageSize=10&scope=USER&projectKey=mao&status=ACTIVE' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.records).toHaveLength(1);
    expect(body.data.total).toBe(1);
    expect(service.list).toHaveBeenCalledWith(7, { scope: 'USER', projectKey: 'mao', status: 'ACTIVE', page: 2, pageSize: 10 });
  });

  it('listDefaultsPaginationAndSkipsInvalidFilters', async () => {
    const app = buildApp(service);
    await app.inject({ method: 'GET', url: '/v1/memory?scope=BOGUS&status=X&page=-3&pageSize=9999' });
    expect(service.list).toHaveBeenCalledWith(7, { scope: null, projectKey: null, status: null, page: 1, pageSize: 100 });
  });

  it('createDelegatesToService', async () => {
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/memory',
      payload: { scope: 'PROJECT', content: '测试用 Vitest', projectKey: 'mao' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.content).toBe('输出报告用中文');
    expect(service.create).toHaveBeenCalledWith(7, { scope: 'PROJECT', content: '测试用 Vitest', projectKey: 'mao' });
  });

  it('updateAndDeletePassPathId', async () => {
    const app = buildApp(service);
    const patched = await app.inject({ method: 'PATCH', url: '/v1/memory/3', payload: { status: 'DISMISSED' } });
    expect(patched.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(7, 3, { content: null, status: 'DISMISSED' });

    const removed = await app.inject({ method: 'DELETE', url: '/v1/memory/3' });
    expect(removed.statusCode).toBe(200);
    expect(service.remove).toHaveBeenCalledWith(7, 3);
  });

  it('invalidPathIdReturnsNotFound', async () => {
    const app = buildApp(service);
    const res = await app.inject({ method: 'PATCH', url: '/v1/memory/abc', payload: { status: 'ACTIVE' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(3033);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('serviceErrorsFlowThroughHandleError', async () => {
    service.create.mockImplementation(async () => {
      throw new BusinessException(ErrorCode.MEMORY_LIMIT_EXCEEDED);
    });
    const app = buildApp(service);
    const res = await app.inject({ method: 'POST', url: '/v1/memory', payload: { scope: 'USER', content: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(ErrorCode.MEMORY_LIMIT_EXCEEDED.code);
  });

  it('settingsDefaultOffAndPatchToggles', async () => {
    const app = buildApp(service);
    const got = await app.inject({ method: 'GET', url: '/v1/memory/settings' });
    expect(got.json().data).toEqual({ autoCaptureEnabled: false });

    const patched = await app.inject({ method: 'PATCH', url: '/v1/memory/settings', payload: { autoCaptureEnabled: false } });
    expect(patched.json().data).toEqual({ autoCaptureEnabled: false });
    expect(service.updateAutoCaptureEnabled).toHaveBeenCalledWith(7, false);
  });

  it('settingsPatchRequiresExplicitBoolean', async () => {
    const app = buildApp(service);
    const res = await app.inject({ method: 'PATCH', url: '/v1/memory/settings', payload: {} });
    expect(res.json().code).toBe(2001);
    expect(service.updateAutoCaptureEnabled).not.toHaveBeenCalled();
  });

  it('projectsReturnsDropdownSource', async () => {
    const app = buildApp(service);
    const res = await app.inject({ method: 'GET', url: '/v1/memory/projects' });
    expect(res.json().data).toEqual({ projects: ['mao', 'web'] });
  });
});

// ── 请求体类型校验回归（评审确认缺陷的修复回归：非字符串 content 必须走 PARAM_INVALID 而非 500/强转） ──
describe('memory routes validate request payload types', () => {
  function realServiceRepo(overrides: Record<string, unknown> = {}) {
    return {
      page: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      countActive: vi.fn(async () => 0),
      findById: vi.fn(async () => ({
        id: 1,
        userId: 7,
        scope: 'USER',
        projectKey: '',
        content: '旧内容',
        source: 'MANUAL',
        status: 'ACTIVE',
        dedupHash: 'h',
        originSessionId: null,
        createdAt: '2026-10-02 10:00:00',
        updatedAt: '2026-10-02 10:00:00',
      })),
      findByHash: vi.fn(async () => null),
      insert: vi.fn(async () => 1),
      updateContent: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
      deleteById: vi.fn(async () => undefined),
      listActiveUser: vi.fn(async () => []),
      listActiveProject: vi.fn(async () => []),
      findPreference: vi.fn(async () => null),
      insertPreference: vi.fn(async () => undefined),
      updatePreference: vi.fn(async () => undefined),
      transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
      ...overrides,
    } as never as MemoryRepository;
  }

  function appWith(service: MemoryServiceType): ReturnType<typeof Fastify> {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    registerMemoryRoutes(fastify, { memoryService: service });
    return fastify;
  }

  it('patchWithNonStringContentReturnsParamInvalidInsteadOf500', async () => {
    // 路由 body.content ?? null 未做类型校验，非字符串透传到 normalizeMemoryContent，
    // (123 ?? '').replace 抛 TypeError → handleError 按 5001 内部错误返回
    const service = new MemoryService(realServiceRepo(), { listProjectKeyRows: async () => [] });
    const res = await appWith(service).inject({ method: 'PATCH', url: '/v1/memory/1', payload: { content: 123 } });
    expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('postWithObjectContentReturnsParamInvalidInsteadOfCoercing', async () => {
    // String(body.content ?? '') 把 {a:1} 强转为 '[object Object]'：治理层应拒绝而非落库
    const service = new MemoryService(realServiceRepo(), { listProjectKeyRows: async () => [] });
    const res = await appWith(service).inject({ method: 'POST', url: '/v1/memory', payload: { scope: 'USER', content: { a: 1 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
  });
});
