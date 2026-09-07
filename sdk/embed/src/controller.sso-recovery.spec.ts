import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedController, createUiState } from './controller';
import { RestClient } from './core/rest-client';
import type { MaoChatInitOptions } from './types';

class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { target: Socket; data: string }) => void) | null = null;
  onclose: ((event: { target: Socket; code: number }) => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(data: unknown) { this.onmessage?.({ target: this, data: JSON.stringify(data) }); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ target: this, code }); }
}
let controller: EmbedController | undefined;
afterEach(() => { controller?.destroy(); controller = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); Socket.instances = []; });
function harness(failFirst = false) {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('BroadcastChannel', undefined);
  let exchanges = 0;
  let denied = false;
  let userId = 1;
  const fetcher = vi.fn(async (url: string) => {
    let data: unknown;
    if (url.endsWith('/auth/sso/exchange')) {
      exchanges++;
      if (failFirst && exchanges === 1) return new Response('{}', { status: 503 });
      if (denied) return new Response('{"code":1401}', { status: 401 });
      data = { accessToken: `access-${exchanges}`, expiresIn: 300, expiresAt: Date.now() + 300000, refreshAfter: 100, user: { id: userId, displayName: 'Test' } };
    } else if (url.endsWith('/agents/9')) data = { id: 9 };
    else if (url.includes('/messages')) data = { messages: [], hasMore: false };
    else data = { id: 11, title: 'Existing conversation' };
    return new Response(JSON.stringify({ code: 0, data }));
  });
  vi.stubGlobal('fetch', fetcher);
  const options: MaoChatInitOptions = { serverUrl: 'https://mao.example.test', agentId: 9, auth: { type: 'company-sso', getSsoToken: async () => 'synthetic', checkUrl: 'https://app.example.test/check' } };
  const ui = createUiState(options);
  controller = new EmbedController(options, ui, vi.fn(), vi.fn());
  const tokens = (controller as unknown as { tokens: { resume(): void; get(): Promise<string> } }).tokens;
  return { ctl: controller, ui, tokens, fetcher, switchUser: (id: number) => { userId = id; }, exchanges: () => exchanges, deny: (value: boolean) => { denied = value; } };
}
async function authenticate(socket: Socket) {
  socket.open(); await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent.some((frame) => frame.type === 'auth')).toBe(true);
  socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
  await vi.advanceTimersByTimeAsync(0);
}

describe('SSO panel recovery', () => {
  it('binds expiry to the new account and to cached credentials on reconnect', async () => {
    const h = harness(); h.ctl.open(); await vi.advanceTimersByTimeAsync(0);
    await authenticate(Socket.instances[0]);
    const start = Date.now();
    vi.setSystemTime(start + 250000);
    h.switchUser(2); h.tokens.resume(); await h.tokens.get();
    await vi.advanceTimersByTimeAsync(0);
    const b = Socket.instances[Socket.instances.length - 1];
    await authenticate(b);
    // Reconnect with cached B, without a fresh onUpdate callback.
    b.close(); await vi.advanceTimersByTimeAsync(1000);
    const reconnected = Socket.instances[Socket.instances.length - 1];
    await authenticate(reconnected);
    vi.setSystemTime(start + 350000);
    h.tokens.resume(); await h.tokens.get();
    const frame = reconnected.sent.find((f) => f.type === 'auth_refresh');
    expect(frame).toBeDefined();
    reconnected.emit({ type: 'auth_refreshed', requestId: frame!.requestId, expiresAt: Date.now() + 300000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnected.readyState).toBe(Socket.OPEN);
    expect(reconnected.sent.filter((f) => f.type === 'subscribe')).toHaveLength(1);
    expect(reconnected.sent.some((f) => f.type === 'send_message')).toBe(false);
  });

  it.each([false, true])('bounds final REST 401 to its credential (superseded=%s)', async (superseded) => {
    const h = harness(); h.ctl.open(); await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0]; await authenticate(socket);
    const rest = (h.ctl as unknown as { rest: RestClient }).rest;
    let finish!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const original = h.fetcher.getMockImplementation()!;
    let requests = 0;
    h.fetcher.mockImplementation(async (url: string) => {
      if (url.endsWith('/race')) {
        requests++;
        return requests === 1 ? new Response('{"code":1001}', { status: 401 }) : delayed;
      }
      return original(url);
    });
    const request = rest.request('POST', '/race');
    const rejected = expect(request).rejects.toThrow('unauthorized');
    await vi.advanceTimersByTimeAsync(0);
    const confirm = () => {
      const frames = socket.sent.filter((f) => f.type === 'auth_refresh');
      const frame = frames[frames.length - 1];
      socket.emit({ type: 'auth_refreshed', requestId: frame.requestId, expiresAt: Date.now() + 300000 });
    };
    confirm();
    if (superseded) { h.tokens.resume(); await h.tokens.get(); confirm(); }
    finish(new Response('{"code":1001}', { status: 401 }));
    await rejected;
    expect(requests).toBe(2);
    if (superseded) {
      expect(await h.tokens.get()).toBe('access-3');
      expect(socket.readyState).toBe(Socket.OPEN);
    } else {
      await expect(h.tokens.get()).rejects.toThrow('登录凭据已失效');
      expect(socket.readyState).toBe(Socket.CLOSED);
    }
  });

  it('reconnects on reopen after authentication recovered while hidden', async () => {
    const h = harness(); h.ctl.open(); await vi.advanceTimersByTimeAsync(0);
    await authenticate(Socket.instances[0]);
    h.deny(true); h.tokens.resume(); await expect(h.tokens.get()).rejects.toThrow();
    h.deny(false);
    h.fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    h.ctl.retry(); await vi.advanceTimersByTimeAsync(0);
    h.ctl.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(Socket.instances).toHaveLength(1);
    const exchanges = h.exchanges();
    h.ctl.open(); await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(2);
    await authenticate(Socket.instances[1]);
    expect(h.exchanges()).toBe(exchanges);
    expect(h.ui.connected).toBe(true);
    expect(Socket.instances[1].sent.filter((f) => f.type === 'subscribe')).toHaveLength(1);
    expect(h.fetcher.mock.calls.filter(([url]) => url.includes('/messages'))).toHaveLength(2);
    expect(Socket.instances[1].sent.some((f) => f.type === 'send_message')).toBe(false);
  });

  it('retries initial outage and boots without another user action', async () => {
    const h = harness(true); h.ctl.open();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.exchanges()).toBe(2);
    expect(Socket.instances).toHaveLength(1);
    await authenticate(Socket.instances[0]);
    expect(h.ctl.store.sessionId()).toBe(11);
    expect(h.ui.connected).toBe(true);
  });

  it('renews after access closure without treating a valid SSO as logged out', async () => {
    const h = harness(); h.ctl.open(); await vi.advanceTimersByTimeAsync(0);
    await authenticate(Socket.instances[0]);
    Socket.instances[0].close(1003);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.exchanges()).toBe(2);
    expect(Socket.instances).toHaveLength(2);
    await authenticate(Socket.instances[1]);
    expect(Socket.instances[1].sent).toContainEqual({ type: 'subscribe', sessionId: 11 });
    expect(h.fetcher.mock.calls.filter(([url]) => url.includes('/messages'))).toHaveLength(2);
    expect(Socket.instances[1].sent.some((frame) => frame.type === 'send_message')).toBe(false);
  });

  it('restores same-account subscriptions and history after actual SSO failure', async () => {
    const h = harness(); h.ctl.open(); await vi.advanceTimersByTimeAsync(0);
    await authenticate(Socket.instances[0]);
    h.deny(true); h.tokens.resume(); await expect(h.tokens.get()).rejects.toThrow();
    h.deny(false); h.ctl.retry(); await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(2);
    await authenticate(Socket.instances[1]);
    expect(Socket.instances[1].sent).toContainEqual({ type: 'subscribe', sessionId: 11 });
    expect(h.fetcher.mock.calls.filter(([url]) => url.includes('/messages'))).toHaveLength(2);
    expect(h.ctl.store.sessionId()).toBe(11);
  });
});
