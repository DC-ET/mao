import { describe, expect, it, vi } from 'vitest';
import type { SignalWatcher } from './types.js';
import { registerSignalAdminRoutes } from './signal-admin.routes.js';
import { MysqlSignalWatcherRepository } from './signal.repository.js';

function watcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
  return {
    id: 1,
    userId: 7,
    agentId: 3,
    name: 'w',
    url: 'https://example.com/api',
    method: 'GET',
    headersJson: null,
    body: null,
    intervalMinutes: 15,
    compareMode: 'HASH',
    jsonPath: null,
    promptTemplate: 'p',
    status: 'ACTIVE',
    lastValueHash: null,
    lastValueSnippet: null,
    lastChangeOldSnippet: null,
    lastChangeNewSnippet: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    consecutiveFailures: 0,
    triggerMode: 'NEW_SESSION',
    reuseSessionId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** 造一个只记录 SQL 的假 Db，用来断言 listForAdmin 的筛选与分页口径。 */
function makeFakeDb(captured: { sql: string[]; params: unknown[][] }) {
  return {
    queryOne: vi.fn(async () => ({ c: 1 })),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      captured.sql.push(sql);
      captured.params.push(params);
      return [watcher()];
    }),
    execute: vi.fn(async () => 1),
  };
}

function makeRepo(captured: { sql: string[]; params: unknown[][] }) {
  return new MysqlSignalWatcherRepository(makeFakeDb(captured) as never);
}

describe('signal-admin listForAdmin 筛选与分页', () => {
  it('compareMode 筛选会拼进 WHERE 与参数（BUG-5 回归）', async () => {
    const captured = { sql: [] as string[], params: [] as unknown[][] };
    const repo = makeRepo(captured);
    await repo.listForAdmin(1, 20, { status: 'ACTIVE', userId: 7, compareMode: 'STATUS_CODE' });
    expect(captured.sql[0]).toContain('compare_mode = ?');
    expect(captured.params[0]).toContain('STATUS_CODE');
    expect(captured.params[0]).toContain('ACTIVE');
    expect(captured.params[0]).toContain(7);
  });

  it('LIMIT 与 OFFSET 使用同一个钳制后的 size（BUG-6 回归）', async () => {
    const captured = { sql: [] as string[], params: [] as unknown[][] };
    const repo = makeRepo(captured);
    await repo.listForAdmin(3, 300, {});
    // size=300 被钳到 200：第 3 页 offset 应为 (3-1)*200=400，而不是 600
    expect(captured.sql[0]).toContain('LIMIT 200 OFFSET 400');
  });

  it('size 为 0 或负值时 LIMIT 至少为 1', async () => {
    const captured = { sql: [] as string[], params: [] as unknown[][] };
    const repo = makeRepo(captured);
    await repo.listForAdmin(1, 0, {});
    expect(captured.sql[0]).toContain('LIMIT 1 OFFSET 0');
  });
});

describe('registerSignalAdminRoutes compareMode 入参', () => {
  it('把 compareMode 传给 listForAdmin，非法值忽略', async () => {
    const listForAdmin = vi.fn(async () => ({ rows: [watcher()], total: 1 }));
    const app = { get: vi.fn() };
    registerSignalAdminRoutes(app as never, {
      watcherRepo: { listForAdmin } as never,
      service: {} as never,
      permissionService: { hasPermission: vi.fn(async () => true) } as never,
      userLookup: { findByIds: vi.fn(async () => [{ id: 7, username: 'u', displayName: 'U' }]) },
    });
    const handler = app.get.mock.calls[0]![1] as (req: unknown, reply: unknown) => Promise<unknown>;
    // sendOk 需要 reply.status().header().send() 链
    const reply = {
      status: vi.fn(() => reply),
      header: vi.fn(() => reply),
      send: vi.fn((payload: unknown) => payload),
    };
    // requireRequestPermission 走 request.userId（登录态守卫已注入）
    const req = (query: Record<string, unknown>) => ({ userId: 1, query });
    await handler(req({ compareMode: 'STATUS_CODE' }), reply);
    expect(listForAdmin).toHaveBeenCalledWith(1, 20, { status: null, userId: undefined, compareMode: 'STATUS_CODE' });

    listForAdmin.mockClear();
    await handler(req({ compareMode: 'NOT_A_MODE' }), reply);
    expect(listForAdmin).toHaveBeenCalledWith(1, 20, { status: null, userId: undefined, compareMode: null });
  });

  it('列表行透出 jsonPath，JSON 字段模式的「上次变化内容」能带上路径', async () => {
    const listForAdmin = vi.fn(async () => ({
      rows: [watcher({ compareMode: 'JSON_FIELD', jsonPath: 'data.price', lastChangeOldSnippet: '1', lastChangeNewSnippet: '2' })],
      total: 1,
    }));
    const app = { get: vi.fn() };
    registerSignalAdminRoutes(app as never, {
      watcherRepo: { listForAdmin } as never,
      service: {} as never,
      permissionService: { hasPermission: vi.fn(async () => true) } as never,
      userLookup: { findByIds: vi.fn(async () => []) },
    });
    const handler = app.get.mock.calls[0]![1] as (req: unknown, reply: unknown) => Promise<unknown>;
    const reply = makeReply();
    const payload = parsePayload(await handler({ userId: 1, query: {} }, reply));
    const data = payload.data as { records: Array<Record<string, unknown>> };
    expect(data.records[0]).toMatchObject({ compareMode: 'JSON_FIELD', jsonPath: 'data.price' });
  });
});

/** 造一个可走 sendOk 的 reply 桩（status → header → send 链式调用）。 */
function makeReply() {
  const reply: {
    status: ReturnType<typeof vi.fn>;
    header: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  } = {
    status: vi.fn(() => reply),
    header: vi.fn(() => reply),
    send: vi.fn((payload: unknown) => payload),
  };
  return reply;
}

function routeHandler(app: { get: ReturnType<typeof vi.fn> }, path: string) {
  const call = app.get.mock.calls.find((c: unknown[]) => c[0] === path);
  if (!call) throw new Error(`未注册路由: ${path}`);
  return call[1] as (req: unknown, reply: unknown) => Promise<unknown>;
}

/** sendJson 交给 reply.send 的是 Jackson 序列化后的字符串，这里反序列化便于断言。 */
function parsePayload(raw: unknown): { data?: unknown } {
  return JSON.parse(String(raw)) as { data?: unknown };
}

function setupAdminDetail() {
  const getForAdmin = vi.fn(async () => ({
    id: 5,
    userId: 7,
    name: 'w',
    url: 'https://example.com/api',
    method: 'GET',
  }));
  const listChecksForAdmin = vi.fn(async () => ({
    rows: [{ id: 1, watcherId: 5, httpStatus: 200, changed: 1, triggeredSessionId: 42, error: null, durationMs: 8, warning: null }],
    total: 1,
  }));
  const app = { get: vi.fn() };
  registerSignalAdminRoutes(app as never, {
    watcherRepo: { listForAdmin: vi.fn() } as never,
    service: { getForAdmin, listChecksForAdmin } as never,
    permissionService: { hasPermission: vi.fn(async () => true) } as never,
    userLookup: { findByIds: vi.fn(async () => [{ id: 7, username: 'u', displayName: 'U' }]) },
  });
  return { app, getForAdmin, listChecksForAdmin };
}

describe('registerSignalAdminRoutes 详情与轮询记录', () => {
  it('详情：读取任意哨兵并合入属主展示名', async () => {
    const { app, getForAdmin } = setupAdminDetail();
    const handler = routeHandler(app, '/v1/admin/signal-watchers/:id');
    const payload = parsePayload(await handler({ userId: 1, params: { id: '5' } }, makeReply()));
    expect(getForAdmin).toHaveBeenCalledWith(5);
    expect(payload).toMatchObject({ data: { id: 5, userId: 7, username: 'U' } });
  });

  it('详情：非法 id 抛参数错误且不读服务', async () => {
    const { app, getForAdmin } = setupAdminDetail();
    const handler = routeHandler(app, '/v1/admin/signal-watchers/:id');
    await expect(handler({ userId: 1, params: { id: '0' } }, makeReply())).rejects.toThrow('路径参数 id 必须为正整数');
    expect(getForAdmin).not.toHaveBeenCalled();
  });

  it('轮询记录：透传 page/size 并按统一响应返回', async () => {
    const { app, listChecksForAdmin } = setupAdminDetail();
    const handler = routeHandler(app, '/v1/admin/signal-watchers/:id/checks');
    const payload = parsePayload(await handler({ userId: 1, params: { id: '5' }, query: { page: '2', size: '50' } }, makeReply()));
    expect(listChecksForAdmin).toHaveBeenCalledWith(5, 2, 50);
    expect(payload).toMatchObject({ data: { total: 1, page: 2, size: 50 } });
    const data = payload.data as { records: Array<Record<string, unknown>> };
    expect(data.records[0]).toMatchObject({ watcherId: 5, triggeredSessionId: 42 });
  });

  it('轮询记录：size 超上限钳到 100', async () => {
    const { app, listChecksForAdmin } = setupAdminDetail();
    const handler = routeHandler(app, '/v1/admin/signal-watchers/:id/checks');
    await handler({ userId: 1, params: { id: '5' }, query: { size: '500' } }, makeReply());
    expect(listChecksForAdmin).toHaveBeenCalledWith(5, 1, 100);
  });
});
