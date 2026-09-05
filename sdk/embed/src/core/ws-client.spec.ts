import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from './ws-client';

/**
 * fake WebSocket：必须保留 CONNECTING/OPEN/CLOSING/CLOSED 静态常量，
 * 否则 SDK 内 `readyState === WebSocket.OPEN` 判断异常。
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static constructThrows = false;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { target: unknown; data: string }) => void) | null = null;
  onclose: ((e: { target: unknown; code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closedWith: number | null = null;

  constructor(public readonly url: string) {
    if (FakeWebSocket.constructThrows) throw new Error("Failed to construct 'URL': Invalid URL");
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(payload);
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = code;
    this.onclose?.({ target: this, code });
  }

  // ─── 测试驱动 ───
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(obj: unknown) {
    this.onmessage?.({ target: this, data: JSON.stringify(obj) });
  }

  serverClose(code: number) {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = code;
    this.onclose?.({ target: this, code });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.type === type);
  }
}

function makeHooks(overrides: Partial<Parameters<typeof makeClient>[0]> = {}) {
  const calls = {
    authenticated: [] as boolean[],
    authFailed: 0,
    disconnected: 0,
    events: [] as Array<{ type: string }>,
  };
  const hooks = {
    getToken: overrides.getToken ?? (() => Promise.resolve('tok')),
    onAuthenticated: (isReconnect: boolean) => calls.authenticated.push(isReconnect),
    onAuthFailed: () => calls.authFailed++,
    onDisconnected: () => calls.disconnected++,
    onEvent: (e: { type: string }) => calls.events.push(e),
  };
  return { hooks, calls };
}

function makeClient(hooks: {
  getToken: () => Promise<string>;
  onAuthenticated: (isReconnect: boolean) => void;
  onAuthFailed: () => void;
  onDisconnected: () => void;
  onEvent: (e: never) => void;
}) {
  return new WsClient('https://mao.example.com', hooks as never);
}

describe('WsClient', () => {
  let originalWs: typeof WebSocket;

  beforeEach(() => {
    originalWs = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    FakeWebSocket.constructThrows = false;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWs;
    vi.useRealTimers();
  });

  it('首帧发送 auth，收到 connected 帧才置 authenticated', async () => {
    const { hooks, calls } = makeHooks();
    const ws = makeClient(hooks);
    const p = ws.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await p;
    expect(socket.frames()[0]).toEqual({ type: 'auth', token: 'tok', client: 'embed' });
    expect(ws.connected.value).toBe(true);
    // 尚未收到 connected 帧：业务上不可用
    expect(ws.authenticated.value).toBe(false);

    socket.emit({ type: 'connected', sessionId: null, data: { userId: 1 } });
    expect(ws.authenticated.value).toBe(true);
    expect(calls.authenticated).toEqual([false]);
    // connected 帧同时透传给业务层
    expect(calls.events.map((e) => e.type)).toEqual(['connected']);
    ws.disconnect();
  });

  it('subscribe 只发一次：鉴权前登记意图，鉴权后统一补发', async () => {
    const { hooks } = makeHooks();
    const ws = makeClient(hooks);
    const p = ws.connect();
    const socket = FakeWebSocket.instances[0];
    // 鉴权前 subscribe 不发帧
    ws.subscribe(42);
    socket.open();
    await p;
    expect(socket.framesOfType('subscribe')).toHaveLength(0);

    socket.emit({ type: 'connected', sessionId: null, data: {} });
    expect(socket.framesOfType('subscribe')).toHaveLength(1);
    // 重复 subscribe 同一会话不再发帧（服务端会重放快照）
    ws.subscribe(42);
    expect(socket.framesOfType('subscribe')).toHaveLength(1);
    ws.disconnect();
  });

  it('重连后按订阅意图恢复，并以 isReconnect=true 通知上层对账', async () => {
    vi.useFakeTimers();
    const { hooks, calls } = makeHooks();
    const ws = makeClient(hooks);
    const p1 = ws.connect();
    const s1 = FakeWebSocket.instances[0];
    ws.subscribe(7);
    s1.open();
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    s1.emit({ type: 'connected', sessionId: null, data: {} });
    expect(s1.framesOfType('subscribe')).toHaveLength(1);

    s1.serverClose(1006);
    expect(ws.connected.value).toBe(false);
    expect(ws.authenticated.value).toBe(false);
    expect(calls.disconnected).toBe(1);

    // 退避 1s 后自动重连
    await vi.advanceTimersByTimeAsync(1_100);
    const s2 = FakeWebSocket.instances[1];
    expect(s2).toBeDefined();
    s2.open();
    await vi.advanceTimersByTimeAsync(0);
    s2.emit({ type: 'connected', sessionId: null, data: {} });
    expect(s2.framesOfType('subscribe')).toEqual([{ type: 'subscribe', sessionId: 7 }]);
    expect(calls.authenticated).toEqual([false, true]);
    ws.disconnect();
  });

  it('close(1003) 触发 onAuthFailed', async () => {
    vi.useFakeTimers();
    const { hooks, calls } = makeHooks();
    const ws = makeClient(hooks);
    const p = ws.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    socket.serverClose(1003);
    expect(calls.authFailed).toBe(1);
    ws.disconnect();
  });

  it('getToken 失败时关闭未鉴权 socket（不留僵尸连接）', async () => {
    const { hooks } = makeHooks({ getToken: () => Promise.reject(new Error('token 500')) });
    const ws = makeClient(hooks);
    const p = ws.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await expect(p).rejects.toThrow('token 500');
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(ws.connected.value).toBe(false);
    ws.disconnect();
  });

  it('WebSocket 构造同步抛错转为 rejected promise', async () => {
    FakeWebSocket.constructThrows = true;
    const { hooks } = makeHooks();
    const ws = makeClient(hooks);
    await expect(ws.connect()).rejects.toThrow('Failed to construct');
    expect(ws.connected.value).toBe(false);
    ws.disconnect();
  });

  it('sendReliable 在 socket 不可用且重连失败时返回 false', async () => {
    FakeWebSocket.constructThrows = true;
    const { hooks } = makeHooks();
    const ws = makeClient(hooks);
    await expect(ws.cancel(1)).resolves.toBe(false);
    ws.disconnect();
  });

  it('unsubscribe 移除订阅意图，重连后不再恢复', async () => {
    vi.useFakeTimers();
    const { hooks } = makeHooks();
    const ws = makeClient(hooks);
    const p = ws.connect();
    const s1 = FakeWebSocket.instances[0];
    ws.subscribe(11);
    s1.open();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    s1.emit({ type: 'connected', sessionId: null, data: {} });
    ws.unsubscribe(11);
    expect(s1.framesOfType('unsubscribe')).toEqual([{ type: 'unsubscribe', sessionId: 11 }]);
    expect(ws.trackedSessionIds()).toEqual([]);

    s1.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_100);
    const s2 = FakeWebSocket.instances[1];
    s2.open();
    await vi.advanceTimersByTimeAsync(0);
    s2.emit({ type: 'connected', sessionId: null, data: {} });
    expect(s2.framesOfType('subscribe')).toHaveLength(0);
    ws.disconnect();
  });

  it('心跳静默超时后关闭连接并重连', async () => {
    vi.useFakeTimers();
    const { hooks } = makeHooks();
    const ws = makeClient(hooks);
    const p = ws.connect();
    const s1 = FakeWebSocket.instances[0];
    s1.open();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    // 5s 心跳发 ping
    await vi.advanceTimersByTimeAsync(5_100);
    expect(s1.framesOfType('ping')).toHaveLength(1);
    // 30s 静默无服务端消息 → 主动 close
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s1.readyState).toBe(FakeWebSocket.CLOSED);
    ws.disconnect();
  });

  it('disconnect 清空订阅意图并 settle 在途 connect', async () => {
    const { hooks } = makeHooks();
    const ws = makeClient(hooks);
    const p = ws.connect();
    ws.subscribe(3);
    ws.disconnect();
    await expect(p).rejects.toThrow(/cancelled|closed/i);
    expect(ws.trackedSessionIds()).toEqual([]);
    expect(ws.authenticated.value).toBe(false);
  });
});
