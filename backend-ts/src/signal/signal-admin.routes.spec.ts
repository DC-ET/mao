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
});
