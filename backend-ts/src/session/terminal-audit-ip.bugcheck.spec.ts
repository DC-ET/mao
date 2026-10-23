import Fastify from 'fastify';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleError } from '../common/http-error.js';
import { loadTrustedProxyAddresses } from '../config/trusted-proxy.js';
import { registerTerminalRoutes } from './terminal.routes.js';
import type { TerminalManager } from '../harness/terminal/terminal-manager.js';
import type { Session } from './types.js';

/**
 * BUGCHECK（审查新增，非产品代码）：终端审计记录的 IP 允许被客户端任意伪造。
 *
 * 根因：`audit/audit.interceptor.ts` 的 `resolveIp()` 无条件优先取
 * `x-forwarded-for` / `x-real-ip`，而仓库自身的信任策略在
 * `config/trusted-proxy.ts` 明确写着「Only exact configured reverse-proxy IPs
 * are trusted; never trust arbitrary X-Forwarded-* input」（生产用
 * `TRUSTED_PROXY_ADDRESSES` 控制 Fastify 的 trustProxy）。
 *
 * 后果：`session/terminal.routes.ts`（创建/关闭终端）与
 * `session/ws/attach-websocket.ts`（WS 接入）把 resolveIp 的结果写进终端审计，
 * 于是任何调用方只要带一个 `X-Forwarded-For: 1.2.3.4` 头，就能把自己的操作
 * 记到任意 IP 上（审计失真 / 追责失效）。REST 审计走的是 `request.ip`
 * （受 trustProxy 约束），同一套审计出现两种口径。
 *
 * 断言按「本应如此」书写：未配置可信代理时，落库的必须是直连对端地址；
 * 直连对端确实是可信代理时，才允许采用 X-Forwarded-For。
 * 当前源码下第一条断言失败即证明 BUG 真实存在。
 */

const ORIGINAL_ENV = process.env.TRUSTED_PROXY_ADDRESSES;

describe('BUGCHECK terminal audit IP must follow the trusted-proxy policy', () => {
  beforeEach(() => {
    // 默认部署：未配置可信反代
    process.env.TRUSTED_PROXY_ADDRESSES = '';
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.TRUSTED_PROXY_ADDRESSES;
    } else {
      process.env.TRUSTED_PROXY_ADDRESSES = ORIGINAL_ENV;
    }
  });

  function buildApp() {
    const app = Fastify({ trustProxy: loadTrustedProxyAddresses() });
    app.setErrorHandler(handleError);
    // 测试身份：请求 userId = 7（认证链路已由全局 hook 负责）
    app.addHook('preHandler', (req, _reply, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });

    const create = vi.fn(async () => ({
      toInfo: () => ({ terminalId: 'term-1', sessionId: 5, cols: 80, rows: 24 }),
    }));
    const terminalManager = {
      create,
      list: vi.fn(async () => []),
      get: vi.fn(() => null),
      close: vi.fn(),
    } as unknown as TerminalManager;

    const session = {
      id: 5,
      userId: 7,
      workspace: '/tmp/mao-ws',
      title: 'task',
      executionMode: 'CLOUD',
    } as unknown as Session;

    registerTerminalRoutes(app, {
      terminalManager,
      sessionService: { getSession: vi.fn(async () => session) },
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    return { app, create };
  }

  it('records the direct peer address when no trusted proxy is configured', async () => {
    const { app, create } = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/5/terminals',
      headers: {
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '198.51.100.7',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as { ip?: string };
    // 直连对端（light-my-request 默认 127.0.0.1）才是真实来源；
    // 客户端自带的 X-Forwarded-For 不得直接落库。
    expect(arg.ip).toBe('127.0.0.1');
  });

  it('keeps X-Forwarded-For when the peer itself is a configured trusted proxy (control group)', async () => {
    process.env.TRUSTED_PROXY_ADDRESSES = '127.0.0.1';
    const { app, create } = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/5/terminals',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(res.statusCode).toBe(200);
    const arg = create.mock.calls[0][0] as { ip?: string };
    expect(arg.ip).toBe('203.0.113.9');
  });
});
