import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSignalWatcherRoutes, toInput } from './watcher.routes.js';
import { WatcherService } from './watcher.service.js';
import { SignalSecretCipher } from './signal-cipher.js';
import { executeProbe } from './probe-client.js';
import type { SignalWatcher, SignalWatcherCheck } from './types.js';
import type { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal.repository.js';

/**
 * 路由层回归（第 2 轮 BUG-H/BUG-A/BUG-B）。
 *
 * 直接调 service.update 的 spec 绕过了 toInput 的键存在性判定，覆盖不到真实 HTTP 入口，
 * 因此这里用真实 Fastify + app.inject 打通「前端 payload → 路由 → service」全链路。
 */

const SECRET = 'test-signal-secret';

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
    promptTemplate: 'changed {diff}',
    status: 'ACTIVE',
    lastValueHash: null,
    lastValueSnippet: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    consecutiveFailures: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeHarness(seed: SignalWatcher) {
  const watchers = new Map<number, SignalWatcher>([[1, seed]]);
  const checks: SignalWatcherCheck[] = [];
  const cipher = new SignalSecretCipher(SECRET);
  const watcherRepo = {
    insert: vi.fn(async (row: Omit<SignalWatcher, 'id'>) => {
      const id = watchers.size + 1;
      watchers.set(id, { ...row, id } as SignalWatcher);
      return id;
    }),
    findById: vi.fn(async (id: number) => watchers.get(id) ?? null),
    findOwned: vi.fn(async (id: number, userId: number) => {
      const row = watchers.get(id);
      return row != null && row.userId === userId ? row : null;
    }),
    listByUser: vi.fn(async (userId: number) => [...watchers.values()].filter((w) => w.userId === userId)),
    countByUser: vi.fn(async (userId: number) => [...watchers.values()].filter((w) => w.userId === userId).length),
    listForAdmin: vi.fn(async () => ({ rows: [...watchers.values()], total: watchers.size })),
    update: vi.fn(async (id: number, _userId: number, patch: Partial<SignalWatcher>) => {
      const row = watchers.get(id);
      if (row == null) return false;
      Object.assign(row, patch);
      return true;
    }),
    listDue: vi.fn(async () => []),
    markChecked: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => null),
    delete: vi.fn(async (id: number) => { watchers.delete(id); return true; }),
  };
  const checkRepo = {
    insert: vi.fn(async () => 1),
    markTriggered: vi.fn(async () => undefined),
    updateHash: vi.fn(async () => undefined),
    markChanged: vi.fn(async () => undefined),
    markWarning: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    listByWatcher: vi.fn(async () => checks),
    countByWatcher: vi.fn(async () => checks.length),
    countRecentTriggers: vi.fn(async () => 0),
    deleteByWatcher: vi.fn(async () => 0),
    deleteBatch: vi.fn(async () => 0),
  };
  const service = new WatcherService({
    watcherRepo: watcherRepo as unknown as MysqlSignalWatcherRepository,
    checkRepo: checkRepo as unknown as MysqlSignalCheckRepository,
    cipher,
    openRun: { run: vi.fn(async () => ({ sessionId: 9, messageId: 1, queued: false })) } as never,
    probe: { execute: executeProbe },
  });
  const app = Fastify();
  // 登录态守卫注入 userId（requireJwtIdentity 读 req.userId）
  app.addHook('onRequest', async (req) => { (req as { userId?: number }).userId = 7; });
  registerSignalWatcherRoutes(app, { service });
  return { app, watchers, cipher, service };
}

/** 只改名称的编辑 payload（不含 headers/body/jsonPath 键，模拟桌面端按条件下发）。 */
function renameOnly(overrides: Record<string, unknown> = {}) {
  return {
    name: 'renamed',
    agentId: 3,
    url: 'https://example.com/api',
    method: 'GET',
    intervalMinutes: 15,
    compareMode: 'HASH',
    promptTemplate: 'changed {diff}',
    ...overrides,
  };
}

describe('toInput 键存在性判定', () => {
  it('未带 headers/body/jsonPath 键时均为 undefined（未下发）', () => {
    const input = toInput({ name: 'x' });
    expect('headers' in input).toBe(true);
    expect(input.headers).toBeUndefined();
    expect(input.body).toBeUndefined();
    expect(input.jsonPath).toBeUndefined();
  });

  it('显式 null 表示清空', () => {
    const input = toInput({ headers: null, body: null, jsonPath: null });
    expect(input.headers).toBeNull();
    expect(input.body).toBeNull();
    expect(input.jsonPath).toBeNull();
  });

  it('headers 为非对象时报参数错误', () => {
    expect(() => toInput({ headers: 'x' as unknown })).toThrow(/headers 必须为对象/);
    expect(() => toInput({ headers: [] as unknown })).toThrow(/headers 必须为对象/);
  });
});

describe('PUT /v1/signal-watchers/:id 编辑链路（BUG-H/BUG-A/BUG-B 回归）', () => {
  it('只改名称且未下发 headers 时，保留请求头与基线三项', async () => {
    const cipher = new SignalSecretCipher(SECRET);
    const h = makeHarness(watcher({
      headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer SECRET' })),
      lastValueHash: 'abc',
      lastValueSnippet: 'OLD',
      lastChangedAt: '2026-10-11 10:00:00',
    }));
    const res = await h.app.inject({ method: 'PUT', url: '/v1/signal-watchers/1', payload: renameOnly() });
    expect(res.statusCode).toBe(200);
    const stored = h.watchers.get(1)!;
    expect(stored.name).toBe('renamed');
    expect(JSON.parse(h.cipher.decrypt(stored.headersJson!))).toEqual({ Authorization: 'Bearer SECRET' });
    expect(stored.lastValueHash).toBe('abc');
    expect(stored.lastValueSnippet).toBe('OLD');
    expect(stored.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('POST 哨兵只改名称且未下发 body 时不报错，body 原样保留', async () => {
    const cipher = new SignalSecretCipher(SECRET);
    const h = makeHarness(watcher({
      method: 'POST',
      body: cipher.encrypt('{"q":"x"}'),
      lastValueHash: 'abc',
    }));
    const res = await h.app.inject({ method: 'PUT', url: '/v1/signal-watchers/1', payload: renameOnly({ method: 'POST' }) });
    expect(res.statusCode).toBe(200);
    expect(h.cipher.decrypt(h.watchers.get(1)!.body!)).toBe('{"q":"x"}');
    expect(h.watchers.get(1)!.lastValueHash).toBe('abc');
  });

  it('显式 headers: null 可清空请求头（与 body 语义一致）', async () => {
    const cipher = new SignalSecretCipher(SECRET);
    const h = makeHarness(watcher({ headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer SECRET' })) }));
    const res = await h.app.inject({ method: 'PUT', url: '/v1/signal-watchers/1', payload: renameOnly({ headers: null }) });
    expect(res.statusCode).toBe(200);
    expect(h.watchers.get(1)!.headersJson).toBeNull();
  });

  it('显式 headers: {} 同样可清空', async () => {
    const cipher = new SignalSecretCipher(SECRET);
    const h = makeHarness(watcher({ headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer SECRET' })) }));
    const res = await h.app.inject({ method: 'PUT', url: '/v1/signal-watchers/1', payload: renameOnly({ headers: {} }) });
    expect(res.statusCode).toBe(200);
    expect(h.watchers.get(1)!.headersJson).toBeNull();
  });

  it('POST 改成 GET 时清掉库里残留的请求体（BUG-E）', async () => {
    const cipher = new SignalSecretCipher(SECRET);
    const h = makeHarness(watcher({ method: 'POST', body: cipher.encrypt('{"q":"x"}') }));
    const res = await h.app.inject({ method: 'PUT', url: '/v1/signal-watchers/1', payload: renameOnly() });
    expect(res.statusCode).toBe(200);
    expect(h.watchers.get(1)!.body).toBeNull();
  });

  it('掩码值按小写归一还原为库内原值（BUG-F）', async () => {
    const cipher = new SignalSecretCipher(SECRET);
    const h = makeHarness(watcher({ headersJson: cipher.encrypt(JSON.stringify({ authorization: 'Bearer SECRET' })) }));
    // 非前端来源按大写头名回传掩码值
    const res = await h.app.inject({
      method: 'PUT', url: '/v1/signal-watchers/1',
      payload: renameOnly({ headers: { Authorization: '******' } }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(h.cipher.decrypt(h.watchers.get(1)!.headersJson!))).toEqual({ Authorization: 'Bearer SECRET' });
  });
});
