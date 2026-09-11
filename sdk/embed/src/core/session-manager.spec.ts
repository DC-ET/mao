import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager';
import { RestClient } from './rest-client';
import type { EmbedSessionVO } from '@mao/contracts';

// 最小 localStorage stub
class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const sessions = new Map<number, EmbedSessionVO>();
let nextCreatedId = 100;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * 复刻后端真实响应形态（backend-ts/src/common/http-error.ts handleError）：
 * - 会话不存在 → HTTP 200 + {code:3002}
 * - 归属校验失败 → HTTP 403 + {code:1002}
 * 用真实 RestClient 走 fetch，避免 mock 直接抛错时掩盖判据 bug。
 */
function stubFetch(handler?: (url: string, method: string) => Response | undefined) {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const custom = handler?.(url, method);
    if (custom) return custom;
    const getMatch = /\/sessions\/(\d+)$/.exec(url);
    if (method === 'GET' && getMatch) {
      const id = Number(getMatch[1]);
      const s = sessions.get(id);
      if (!s) return jsonResponse(200, { code: 3002, message: '会话不存在' });
      return jsonResponse(200, { code: 0, data: s });
    }
    if (method === 'POST' && url.endsWith('/sessions')) {
      const id = nextCreatedId++;
      const s = { id, title: '网页助手' } as EmbedSessionVO;
      sessions.set(id, s);
      return jsonResponse(200, { code: 0, data: s });
    }
    return jsonResponse(500, { code: 5000, message: 'unexpected' });
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

function newRest(): RestClient {
  return new RestClient('https://mao.example.com/api/v1', async () => 'token');
}

describe('SessionManager', () => {
  const originalFetch = globalThis.fetch;
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    sessions.clear();
    nextCreatedId = 100;
    (globalThis as unknown as { window: { localStorage: MemStorage } }).window =
      { localStorage: storage };
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
  });

  it('首次 resolve 创建会话并写入 localStorage', async () => {
    stubFetch();
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(100);
    expect(storage.getItem('mao_embed_session_isolated_3')).toBe('100');
  });

  it('有记录且会话存在时复用', async () => {
    sessions.set(42, { id: 42, title: 'T' } as EmbedSessionVO);
    storage.setItem('mao_embed_session_isolated_3', '42');
    stubFetch();
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(42);
  });

  it('会话不存在（HTTP 200 + code 3002）时清除记录并新建', async () => {
    storage.setItem('mao_embed_session_isolated_3', '999');
    stubFetch();
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(100);
    expect(storage.getItem('mao_embed_session_isolated_3')).toBe('100');
  });

  it('归属校验失败（HTTP 403 + code 1002）时清除记录并新建', async () => {
    storage.setItem('mao_embed_session_isolated_3', '888');
    stubFetch((url, method) =>
      method === 'GET' && url.includes('/sessions/888')
        ? jsonResponse(403, { code: 1002, message: '无权访问' })
        : undefined,
    );
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(100);
    expect(storage.getItem('mao_embed_session_isolated_3')).toBe('100');
  });

  it('服务端异常（HTTP 500）向上抛出且不丢记录', async () => {
    storage.setItem('mao_embed_session_isolated_3', '7');
    stubFetch((url, method) =>
      method === 'GET' && url.includes('/sessions/7')
        ? jsonResponse(500, { code: 5000, message: 'down' })
        : undefined,
    );
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    await expect(mgr.resolveSession()).rejects.toThrow('down');
    expect(storage.getItem('mao_embed_session_isolated_3')).toBe('7');
  });

  it('startNewSession 替换记录', async () => {
    stubFetch();
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    const first = await mgr.resolveSession();
    const second = await mgr.startNewSession();
    expect(second.id).not.toBe(first.id);
    expect(storage.getItem('mao_embed_session_isolated_3')).toBe(String(second.id));
  });
});

describe('SessionManager embed history', () => {
  const originalFetch = globalThis.fetch;
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    sessions.clear();
    nextCreatedId = 100;
    (globalThis as unknown as { window: { localStorage: MemStorage } }).window =
      { localStorage: storage };
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
  });

  it('createSession 请求体带 source=embed', async () => {
    const fn = stubFetch();
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    await mgr.resolveSession();
    const call = fn.mock.calls.find((c) => String(c[0]).endsWith('/sessions') && (c[1] as RequestInit)?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ agentId: 3, source: 'embed' });
  });

  it('listSessions 按 agentId+source 分页请求', async () => {
    let requestedUrl = '';
    const fn = stubFetch((url) => {
      if (url.includes('source=embed')) {
        requestedUrl = url;
        return jsonResponse(200, {
          code: 0,
          data: { items: [{ id: 5, title: '旧会话' }], total: 1, offset: 20, limit: 20, hasMore: false },
        });
      }
      return undefined;
    });
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    const page = await mgr.listSessions(20);
    expect(requestedUrl).toContain('source=embed');
    expect(requestedUrl).toContain('agentId=3');
    expect(requestedUrl).toContain('offset=20');
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(5);
    expect(fn).toHaveBeenCalled();
  });

  it('markSourceEmbed 对 web 会话发 PUT，已是 embed 时跳过', async () => {
    const fn = stubFetch((_url: string, method: string) => {
      if (method === 'PUT' && /\/sessions\/5\/source$/.test(_url)) {
        return jsonResponse(200, { code: 0, data: { id: 5, source: 'embed' } });
      }
      return undefined;
    });
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    await mgr.markSourceEmbed({ id: 5, title: 'x', source: 'web' });
    expect(fn.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PUT' && String(c[0]).includes('/sessions/5/source'))).toBe(true);
    fn.mockClear();
    await mgr.markSourceEmbed({ id: 5, title: 'x', source: 'embed' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('markSourceEmbed 失败静默不抛出', async () => {
    stubFetch((_url, method) => {
      if (method === 'PUT') return jsonResponse(500, { code: 5000, message: 'down' });
      return undefined;
    });
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    await expect(mgr.markSourceEmbed({ id: 5, title: 'x', source: 'web' })).resolves.toBeUndefined();
  });

  it('adoptSession 更新本地常驻指针', async () => {
    stubFetch();
    const mgr = new SessionManager({ rest: newRest(), agentId: 3 });
    mgr.adoptSession({ id: 77 } as EmbedSessionVO);
    expect(storage.getItem('mao_embed_session_isolated_3')).toBe('77');
  });
});
