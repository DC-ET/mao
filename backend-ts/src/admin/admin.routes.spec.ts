import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerAdminAnalyticsRoutes, registerAdminRuntimeRoutes } from './admin.routes.js';
import type { AdminMemoryAuditor, AdminRouteDeps, AdminUserLookup } from './admin.routes.js';
import type { MemoryItemVO } from '../memory/types.js';

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

describe('admin memory manage routes', () => {
  interface MemoryMocks {
    fastify: ReturnType<typeof Fastify>;
    listForAdmin: ReturnType<typeof vi.fn>;
    updateForAdmin: ReturnType<typeof vi.fn>;
    removeForAdmin: ReturnType<typeof vi.fn>;
    createForAdmin: ReturnType<typeof vi.fn>;
    findByIds: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  }

  function memoryApp(opts: { permission?: boolean; withAuditor?: boolean; withLookup?: boolean } = {}): MemoryMocks {
    const listForAdmin = vi.fn(async () => ({ records: [], total: 0, current: 1, size: 20 }));
    const updateForAdmin = vi.fn(async () => ({ id: 1 }));
    const removeForAdmin = vi.fn(async () => undefined);
    const createForAdmin = vi.fn(async () => ({ id: 2 }));
    const findByIds = vi.fn(async () => [] as Array<{ id: number; username: string; displayName?: string | null }>);
    const search = vi.fn(async () => [] as Array<{ id: number; username: string; displayName?: string | null }>);
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    const deps: Partial<AdminRouteDeps> = {
      jwt: {} as never,
      analytics: {} as never,
      permissionService: { hasPermission: vi.fn(async () => opts.permission ?? true) },
      memoryAuditor: opts.withAuditor === false
        ? undefined
        : { listForAdmin, updateForAdmin, removeForAdmin, createForAdmin } as never,
      memoryUserLookup: opts.withLookup === false ? undefined : { findByIds, search },
    };
    registerAdminRuntimeRoutes(fastify, deps as AdminRouteDeps);
    return { fastify, listForAdmin, updateForAdmin, removeForAdmin, createForAdmin, findByIds, search };
  }

  it('GET 透传新增过滤参数并规范化时间闭区间', async () => {
    const app = memoryApp();
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/v1/admin/memory?userId=7&keyword=abc&source=AUTO&projectKey=mao&scope=USER&status=ACTIVE&updatedFrom=2026-11-01&updatedTo=2026-11-11&page=2&pageSize=50',
    });
    expect(res.statusCode).toBe(200);
    expect(app.listForAdmin).toHaveBeenCalledWith({
      userId: 7,
      keyword: 'abc',
      source: 'AUTO',
      projectKey: 'mao',
      scope: 'USER',
      status: 'ACTIVE',
      updatedFrom: '2026-11-01 00:00:00',
      updatedTo: '2026-11-11 23:59:59',
      page: 2,
      pageSize: 50,
    });
    await app.fastify.close();
  });

  it('跨用户无过滤 → PARAM_INVALID；时间范围不计入合格条件（D5）', async () => {
    const app = memoryApp();
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { code: number }).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(app.listForAdmin).not.toHaveBeenCalled();

    const timeOnly = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory?updatedFrom=2026-11-01&updatedTo=2026-11-11' });
    expect((timeOnly.json() as { code: number }).code).toBe(ErrorCode.PARAM_INVALID.code);
    await app.fastify.close();
  });

  it('跨用户 + keyword 放行，username/displayName 按页内 userId 去重批量补全', async () => {
    const app = memoryApp();
    const records = [
      { id: 1, userId: 5, scope: 'USER', projectKey: null, content: 'a', source: 'AUTO', status: 'ACTIVE', originSessionId: null, createdAt: null, updatedAt: null },
      { id: 2, userId: 6, scope: 'USER', projectKey: null, content: 'b', source: 'AUTO', status: 'ACTIVE', originSessionId: null, createdAt: null, updatedAt: null },
      { id: 3, userId: 5, scope: 'USER', projectKey: null, content: 'c', source: 'AUTO', status: 'ACTIVE', originSessionId: null, createdAt: null, updatedAt: null },
    ] as MemoryItemVO[];
    app.listForAdmin.mockResolvedValueOnce({ records, total: 3, current: 1, size: 20 });
    app.findByIds.mockResolvedValueOnce([
      { id: 5, username: 'alice', displayName: 'Alice' },
      { id: 6, username: 'bob' },
    ]);
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory?keyword=k' });
    expect(res.statusCode).toBe(200);
    expect(app.listForAdmin).toHaveBeenCalledWith(expect.objectContaining({ userId: null, keyword: 'k' }));
    // 一次批量调用（页内 5/6 去重），不是逐行调用
    expect(app.findByIds).toHaveBeenCalledTimes(1);
    expect(app.findByIds).toHaveBeenCalledWith([5, 6]);
    const body = res.json() as { data: { records: Array<{ username: string | null; displayName?: string | null }> } };
    expect(body.data.records[0]).toMatchObject({ username: 'alice', displayName: 'Alice' });
    // lookup 未回 displayName 时字段被 omitNull 剥掉，语义仍为空
    expect(body.data.records[1]).toMatchObject({ username: 'bob' });
    expect(body.data.records[1].displayName ?? null).toBeNull();
    await app.fastify.close();
  });

  it('userId 提供但非法 → PARAM_INVALID，不按跨用户降级', async () => {
    const app = memoryApp();
    for (const raw of ['abc', '0', '-1', '1.5']) {
      const res = await app.fastify.inject({ method: 'GET', url: `/v1/admin/memory?userId=${raw}` });
      expect((res.json() as { code: number }).code, raw).toBe(ErrorCode.PARAM_INVALID.code);
    }
    expect(app.listForAdmin).not.toHaveBeenCalled();
    await app.fastify.close();
  });

  it('时间参数格式非法 → PARAM_INVALID', async () => {
    const app = memoryApp();
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory?keyword=k&updatedFrom=11/01/2026' });
    expect((res.json() as { code: number }).code).toBe(ErrorCode.PARAM_INVALID.code);
    // 形状合法但日历不存在的日期同样拒绝（否则漏到 MySQL 报 Incorrect DATETIME → 5001）
    const invalidDay = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory?keyword=k&updatedFrom=2026-02-30' });
    expect((invalidDay.json() as { code: number }).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(app.listForAdmin).not.toHaveBeenCalled();
    await app.fastify.close();
  });

  it('重复查询参数（数组）取首值，不 500', async () => {
    const app = memoryApp();
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory?keyword=a&keyword=b&page=2' });
    expect(res.statusCode).toBe(200);
    expect(app.listForAdmin).toHaveBeenCalledWith(expect.objectContaining({ keyword: 'a', page: 2 }));
    await app.fastify.close();
  });

  it('GET /v1/admin/memory/users 透传 keyword/pageSize，需 memory:read', async () => {
    const app = memoryApp();
    app.search.mockResolvedValueOnce([{ id: 5, username: 'zhangsan', displayName: '张三' }]);
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/memory/users?keyword=zhang&pageSize=10' });
    expect(res.statusCode).toBe(200);
    expect(app.search).toHaveBeenCalledWith('zhang', 10);
    expect((res.json() as { data: { records: unknown[] } }).data.records).toHaveLength(1);
    await app.fastify.close();

    const denied = memoryApp({ permission: false });
    const resDenied = await denied.fastify.inject({ method: 'GET', url: '/v1/admin/memory/users' });
    expect(resDenied.statusCode).toBe(403);
    await denied.fastify.close();
  });

  it('写接口无 memory:write → 403；有则放行', async () => {
    const denied = memoryApp({ permission: false });
    const patch = await denied.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 'x' } });
    const del = await denied.fastify.inject({ method: 'DELETE', url: '/v1/admin/memory/1' });
    const post = await denied.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 8, scope: 'USER', content: 'x' } });
    expect(patch.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
    expect(post.statusCode).toBe(403);
    await denied.fastify.close();

    const app = memoryApp();
    app.findByIds.mockResolvedValueOnce([{ id: 8, username: 'bob' }]);
    const okPatch = await app.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 'x' } });
    const okDel = await app.fastify.inject({ method: 'DELETE', url: '/v1/admin/memory/1' });
    const okPost = await app.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 8, scope: 'USER', content: 'x' } });
    expect(okPatch.statusCode).toBe(200);
    expect(okDel.statusCode).toBe(200);
    expect(okPost.statusCode).toBe(200);
    expect(app.updateForAdmin).toHaveBeenCalledWith(1, { content: 'x', status: null });
    expect(app.removeForAdmin).toHaveBeenCalledWith(1);
    expect(app.createForAdmin).toHaveBeenCalledWith(8, { scope: 'USER', content: 'x', projectKey: null });
    await app.fastify.close();
  });

  it('非法 path id → 3033', async () => {
    const app = memoryApp();
    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await app.fastify.inject({ method, url: '/v1/admin/memory/abc', payload: method === 'PATCH' ? { content: 'x' } : undefined });
      expect((res.json() as { code: number }).code, method).toBe(ErrorCode.MEMORY_ITEM_NOT_FOUND.code);
    }
    expect(app.updateForAdmin).not.toHaveBeenCalled();
    expect(app.removeForAdmin).not.toHaveBeenCalled();
    await app.fastify.close();
  });

  it('PATCH content 非字符串 → PARAM_INVALID 不 coerce', async () => {
    const app = memoryApp();
    const res = await app.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 123 } });
    expect((res.json() as { code: number }).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(app.updateForAdmin).not.toHaveBeenCalled();
    await app.fastify.close();
  });

  it('业务错误码（3035/3036）透传', async () => {
    const app = memoryApp();
    const { BusinessException } = await import('../common/business-exception.js');
    app.updateForAdmin.mockRejectedValueOnce(new BusinessException(ErrorCode.MEMORY_CONTENT_DUPLICATE));
    const res = await app.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 'x' } });
    expect((res.json() as { code: number }).code).toBe(ErrorCode.MEMORY_CONTENT_DUPLICATE.code);

    app.updateForAdmin.mockRejectedValueOnce(new BusinessException(ErrorCode.MEMORY_LIMIT_EXCEEDED));
    const res2 = await app.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { status: 'ACTIVE' } });
    expect((res2.json() as { code: number }).code).toBe(ErrorCode.MEMORY_LIMIT_EXCEEDED.code);
    await app.fastify.close();
  });

  it('POST 目标用户不存在 → USER_NOT_FOUND；userId 非法 → PARAM_INVALID', async () => {
    const app = memoryApp();
    app.findByIds.mockResolvedValueOnce([]);
    const missing = await app.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 999, scope: 'USER', content: 'x' } });
    expect((missing.json() as { code: number }).code).toBe(ErrorCode.USER_NOT_FOUND.code);
    expect(app.createForAdmin).not.toHaveBeenCalled();

    const bad = await app.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 'abc', scope: 'USER', content: 'x' } });
    expect((bad.json() as { code: number }).code).toBe(ErrorCode.PARAM_INVALID.code);
    await app.fastify.close();
  });

  it('写接口缺可选依赖（auditor/lookup 缺一）→ 5001', async () => {
    const noAuditor = memoryApp({ withAuditor: false });
    const patch = await noAuditor.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 'x' } });
    expect((patch.json() as { code: number }).code).toBe(ErrorCode.INTERNAL_ERROR.code);
    await noAuditor.fastify.close();

    const noLookup = memoryApp({ withLookup: false });
    const post = await noLookup.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 8, scope: 'USER', content: 'x' } });
    expect((post.json() as { code: number }).code).toBe(ErrorCode.INTERNAL_ERROR.code);
    await noLookup.fastify.close();
  });
});
