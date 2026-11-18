import Fastify from 'fastify';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { loadTrustedProxyAddresses } from '../config/trusted-proxy.js';
import { registerTerminalRoutes } from './terminal.routes.js';
import { RelayOpenError, type LocalTerminalRelay } from '../harness/terminal/local-terminal-relay.js';
import { TerminalLimitError, TerminalSpawnError, type TerminalManager } from '../harness/terminal/terminal-manager.js';
import type { RemoteTerminal } from '../harness/terminal/remote-terminal.js';
import type { Session } from './types.js';

/**
 * 终端 REST 的 LOCAL 中继分支（技术方案 2026-11-18-local-terminal-remote §4.3）：
 * LOCAL 创建不再走 terminal:use，改走「归属 + 主机状态」；CLOUD 分支与删除/列表对
 * 两种终端目录生效。鉴权链路（requireUserId）由全局 hook 伪造：请求 userId = 7。
 */

describe('terminal routes LOCAL relay branch', () => {
  beforeEach(() => {
    process.env.TRUSTED_PROXY_ADDRESSES = '';
  });
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_ADDRESSES;
  });

  function buildApp(session: Partial<Session>, relay?: LocalTerminalRelay) {
    const app = Fastify({ trustProxy: loadTrustedProxyAddresses() });
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _reply, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });

    const fullSession = {
      id: 5,
      userId: 7,
      workspace: '/Users/u/proj',
      title: 'task',
      executionMode: 'LOCAL',
      targetDeviceId: 'dev-1',
      agentId: null,
      ...session,
    } as unknown as Session;

    const relayCreate = vi.fn();
    const relayClose = vi.fn();
    const relayGet = vi.fn();
    const relayList = vi.fn(() => [] as ReturnType<RemoteTerminal['toInfo']>[]);

    registerTerminalRoutes(app, {
      terminalManager: {
        create: vi.fn(async () => ({ toInfo: () => ({ terminalId: 'term-cloud', sessionId: 5, userId: 7 }) })),
        list: vi.fn(() => [{ terminalId: 'term-cloud', sessionId: 5, userId: 7, createdAt: 2 }]),
        get: vi.fn(() => null),
        close: vi.fn(),
      } as unknown as TerminalManager,
      relay: relay ?? ({
        create: relayCreate,
        close: relayClose,
        get: relayGet,
        getOwnedByUser: (...args: unknown[]) => relayGet(...args),
        list: relayList,
      } as unknown as LocalTerminalRelay),
      sessionService: { getSession: vi.fn(async () => fullSession) },
      permissionService: { hasPermission: vi.fn(async () => true) },
      userLookup: { findById: vi.fn(async () => ({ username: 'alice' })) },
    });
    return { app, relayCreate, relayClose, relayGet, relayList };
  }

  it('LOCAL：走 relay.create 并返回 kind=local-relay 信息，不检查 terminal:use', async () => {
    const { app, relayCreate } = buildApp({});
    relayCreate.mockImplementation(async () => {
      const info = {
        terminalId: 'term-5-1-abcdef01',
        sessionId: 5,
        userId: 7,
        shell: '/bin/zsh',
        cwd: '/Users/u/proj',
        cols: 80,
        rows: 24,
        createdAt: 1,
        lastActiveAt: 1,
        attached: false,
        kind: 'local-relay',
      };
      return { toInfo: () => info } as unknown as RemoteTerminal;
    });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: { cols: 100, rows: 30 } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { kind?: string; terminalId: string } };
    expect(body.data.kind).toBe('local-relay');
    expect(relayCreate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 5,
      userId: 7,
      deviceId: 'dev-1',
      workspace: '/Users/u/proj',
      cols: 100,
      rows: 30,
      username: 'alice',
    }));
  });

  it('LOCAL 未绑定执行端 → 「请先在桌面客户端打开一次该任务，完成执行端登记」', async () => {
    const { app } = buildApp({ targetDeviceId: null });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    // 仓库约定：业务异常一律 HTTP 200 + Result.code != 0（仅 401/403 例外）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(body.message).toBe('请先在桌面客户端打开一次该任务，完成执行端登记');
  });

  it('LOCAL 工作区为空 → 「任务工作区不可用」', async () => {
    const { app } = buildApp({ workspace: '' });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(body.message).toBe('任务工作区不可用');
  });

  it('主机不在线（RelayOpenError）→ 固定文案 400', async () => {
    const { app, relayCreate } = buildApp({});
    relayCreate.mockRejectedValue(new RelayOpenError('执行端设备离线'));
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(body.message).toBe('执行端设备离线');
  });

  it('达到上限（TerminalLimitError）→ 文案透传', async () => {
    const { app, relayCreate } = buildApp({});
    relayCreate.mockRejectedValue(new TerminalLimitError('该任务的终端数量已达上限 5，请先关闭已有终端'));
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(body.message).toContain('已达上限');
  });

  it('CLOUD：仍先检查 terminal:use，且不经 relay', async () => {
    const { app, relayCreate } = buildApp({ executionMode: 'CLOUD', targetDeviceId: null });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(relayCreate).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).data.terminalId).toBe('term-cloud');
  });

  it('CLOUD 无权限 → 拒绝（权限语义只属于服务器 shell）', async () => {
    const app = Fastify({ trustProxy: loadTrustedProxyAddresses() });
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _reply, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    const session = { id: 5, userId: 7, workspace: '/w', executionMode: 'CLOUD', agentId: null } as unknown as Session;
    registerTerminalRoutes(app, {
      terminalManager: { create: vi.fn(), list: vi.fn(() => []), get: vi.fn(() => null), close: vi.fn() } as unknown as TerminalManager,
      sessionService: { getSession: vi.fn(async () => session) },
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('未装配 relay 的其它执行模式 → 「仅云端任务支持远程终端」（行为与改造前一致）', async () => {
    const { app } = buildApp({ executionMode: 'LOCAL' }, undefined);
    // buildApp 恒传 relay：这里用专门构造的「无 relay」app
    const app2 = Fastify({ trustProxy: loadTrustedProxyAddresses() });
    app2.setErrorHandler(handleError);
    app2.addHook('preHandler', (req, _reply, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    const session = { id: 5, userId: 7, workspace: '/w', executionMode: 'DOCKER', agentId: null } as unknown as Session;
    registerTerminalRoutes(app2, {
      terminalManager: { create: vi.fn(), list: vi.fn(() => []), get: vi.fn(() => null), close: vi.fn() } as unknown as TerminalManager,
      sessionService: { getSession: vi.fn(async () => session) },
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    const res = await app2.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(body.message).toBe('仅云端任务支持远程终端');
  });

  it('GET 列表：云端与中继合并并按 createdAt 排序', async () => {
    const { app, relayList } = buildApp({});
    relayList.mockReturnValue([
      { terminalId: 'term-relay', sessionId: 5, userId: 7, createdAt: 1 },
      { terminalId: 'term-relay-2', sessionId: 5, userId: 7, createdAt: 3 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/5/terminals' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ terminalId: string; createdAt: number }> };
    expect(body.data.map((t) => t.terminalId)).toEqual(['term-relay', 'term-cloud', 'term-relay-2']);
  });

  it('D5：无 terminal:use 的会话主人可 GET / DELETE 中继终端（CLOUD 仍要权限）', async () => {
    // 修复前 GET/DELETE 走 prepare() 统一要权限：D5 目标用户建得了、列不出、关不掉
    const app = Fastify({ trustProxy: loadTrustedProxyAddresses() });
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _reply, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    const session = { id: 5, userId: 7, workspace: '/w', executionMode: 'LOCAL', targetDeviceId: 'dev-1', agentId: null } as unknown as Session;
    const relayGet = vi.fn(() => ({ sessionId: 5, userId: 7, terminalId: 'term-relay' } as unknown as RemoteTerminal));
    const relayClose = vi.fn();
    registerTerminalRoutes(app, {
      terminalManager: { create: vi.fn(), list: vi.fn(() => []), get: vi.fn(() => null), close: vi.fn() } as unknown as TerminalManager,
      relay: {
        get: relayGet,
        getOwnedByUser: relayGet,
        close: relayClose,
        list: vi.fn(() => [{ terminalId: 'term-relay', sessionId: 5, createdAt: 1 }]),
      } as unknown as LocalTerminalRelay,
      sessionService: { getSession: vi.fn(async () => session) },
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const list = await app.inject({ method: 'GET', url: '/v1/sessions/5/terminals' });
    expect(list.statusCode).toBe(200);
    expect((JSON.parse(list.body) as { data: unknown[] }).data).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: '/v1/sessions/5/terminals/term-relay' });
    expect(del.statusCode).toBe(200);
    expect(relayClose).toHaveBeenCalled();
  });

  it('DELETE：中继终端按归属校验后关闭；未知 id 幂等成功', async () => {
    const { app, relayGet, relayClose } = buildApp({});
    relayGet.mockReturnValue({ sessionId: 5, userId: 7, terminalId: 'term-relay' } as unknown as RemoteTerminal);
    let res = await app.inject({ method: 'DELETE', url: '/v1/sessions/5/terminals/term-relay' });
    expect(res.statusCode).toBe(200);
    expect(relayClose).toHaveBeenCalledWith('term-relay', expect.objectContaining({ username: 'alice' }));

    // 归属不符：不是该任务的终端
    relayGet.mockReturnValue({ sessionId: 6, userId: 7, terminalId: 'term-relay' } as unknown as RemoteTerminal);
    res = await app.inject({ method: 'DELETE', url: '/v1/sessions/5/terminals/term-relay' });
    expect(res.statusCode).toBe(403);

    // 未知 id：幂等
    relayGet.mockReturnValue(null);
    res = await app.inject({ method: 'DELETE', url: '/v1/sessions/5/terminals/gone' });
    expect(res.statusCode).toBe(200);
  });

  it('TerminalSpawnError 仍映射 INTERNAL_ERROR（CLOUD 分支行为不变）', async () => {
    const app = Fastify({ trustProxy: loadTrustedProxyAddresses() });
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _reply, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    const session = { id: 5, userId: 7, workspace: '/w', executionMode: 'CLOUD', agentId: null } as unknown as Session;
    registerTerminalRoutes(app, {
      terminalManager: {
        create: vi.fn(async () => { throw new TerminalSpawnError('终端启动失败，请检查服务器日志'); }),
        list: vi.fn(() => []),
        get: vi.fn(() => null),
        close: vi.fn(),
      } as unknown as TerminalManager,
      sessionService: { getSession: vi.fn(async () => session) },
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions/5/terminals', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { code: number };
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR.code);
  });
});
