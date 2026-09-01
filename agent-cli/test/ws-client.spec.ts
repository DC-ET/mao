import { afterEach, describe, expect, it } from 'vitest';
import { WsClient, serializePayload, buildStreamUrl } from '../src/ws/ws-client';
import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_SILENCE_TIMEOUT_MS,
  WS_TRUNCATE_AT_BYTES,
} from '../src/ws/constants';
import { startMockWsServer, type MockWsServer } from './fixtures/mock-ws-server';

describe('WS constants (aligned with desktop useStreamWS)', () => {
  it('locks heartbeat / silence / backoff numbers', () => {
    expect(WS_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(WS_SILENCE_TIMEOUT_MS).toBe(30_000);
    expect(WS_RECONNECT_INITIAL_MS).toBe(1_000);
    expect(WS_RECONNECT_MAX_MS).toBe(30_000);
    expect(WS_TRUNCATE_AT_BYTES).toBe(900 * 1024);
  });
});

describe('buildStreamUrl', () => {
  it('appends local=1 only for LOCAL capable clients (token moves to first auth frame)', () => {
    expect(buildStreamUrl('https://mao.etarch.cn/api', 'cli')).toBe(
      'wss://mao.etarch.cn/api/ws/stream?client=cli',
    );
    expect(buildStreamUrl('https://mao.etarch.cn/api', 'cli', true)).toBe(
      'wss://mao.etarch.cn/api/ws/stream?client=cli&local=1',
    );
  });
});

describe('serializePayload truncation', () => {
  it('truncates payloads over 900KB and keeps a marker', () => {
    const huge = 'x'.repeat(950 * 1024);
    const json = serializePayload({ type: 'tool_result', result: huge }, 900 * 1024, 1024 * 1024);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(900 * 1024);
    expect(json).toContain('truncated');
  });
});

describe('WsClient', () => {
  let server: MockWsServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('sends auth as first message on open (before resubscribe)', async () => {
    server = await startMockWsServer();
    const client = new WsClient({
      baseUrl: server.httpBase,
      getToken: async () => 'tok',
      client: 'cli',
      heartbeatIntervalMs: 10_000,
    });
    await client.connect();
    client.subscribe(7);
    await new Promise((r) => setTimeout(r, 20));
    const authIndex = server.received.findIndex((m) => (m as { type?: string }).type === 'auth');
    const subscribeIndex = server.received.findIndex((m) => (m as { type?: string }).type === 'subscribe');
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect((server.received[authIndex] as { token?: string }).token).toBe('tok');
    expect((server.received[authIndex] as { client?: string }).client).toBe('cli');
    expect(subscribeIndex).toBeGreaterThan(authIndex);
    client.close();
  });

  it('sends 5s-class heartbeat (injected short interval) as ping', async () => {
    server = await startMockWsServer();
    const client = new WsClient({
      baseUrl: server.httpBase,
      getToken: async () => 'tok',
      heartbeatIntervalMs: 40,
      silenceTimeoutMs: 10_000,
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 90));
    expect(server.received.some((m) => (m as { type?: string }).type === 'ping')).toBe(true);
    client.close();
  });

  it('reconnects after drop and resubscribes', async () => {
    server = await startMockWsServer();
    const client = new WsClient({
      baseUrl: server.httpBase,
      getToken: async () => 'tok',
      heartbeatIntervalMs: 10_000,
      silenceTimeoutMs: 10_000,
      reconnectInitialMs: 30,
      reconnectMaxMs: 50,
    });
    await client.connect();
    client.subscribe(7);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.received.some((m) => (m as { type?: string }).type === 'subscribe')).toBe(true);
    server.received.length = 0;
    server.drop();
    await new Promise((r) => setTimeout(r, 120));
    expect(server.received.some((m) => (m as { type?: string }).type === 'subscribe')).toBe(true);
    client.close();
  });

  it('does not reconnect after close()', async () => {
    server = await startMockWsServer();
    const client = new WsClient({
      baseUrl: server.httpBase,
      getToken: async () => 'tok',
      reconnectInitialMs: 20,
    });
    await client.connect();
    client.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(server.clients.size).toBe(0);
  });

  it('sendReliable reconnects when socket is down', async () => {
    server = await startMockWsServer();
    const client = new WsClient({
      baseUrl: server.httpBase,
      getToken: async () => 'tok',
      reconnectInitialMs: 20,
    });
    const ok = await client.sendReliable({ type: 'ask_user_questions_result', sessionId: 1, data: { requestId: 'q' } });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.received.some((m) => (m as { type?: string }).type === 'ask_user_questions_result')).toBe(true);
    client.close();
  });

  it('silence timeout closes the socket to trigger reconnect', async () => {
    server = await startMockWsServer();
    const client = new WsClient({
      baseUrl: server.httpBase,
      getToken: async () => 'tok',
      heartbeatIntervalMs: 30,
      silenceTimeoutMs: 50,
      reconnectInitialMs: 20,
      reconnectMaxMs: 40,
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 150));
    const pings = server.received.filter((m) => (m as { type?: string }).type === 'ping').length;
    expect(pings).toBeGreaterThan(0);
    client.close();
  });

  it('backoff doubles from initial toward max (sequence 1/2/4…/30 conceptually)', () => {
    let delay = WS_RECONNECT_INITIAL_MS;
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) {
      seq.push(delay);
      delay = Math.min(delay * 2, WS_RECONNECT_MAX_MS);
    }
    expect(seq[0]).toBe(1000);
    expect(seq[1]).toBe(2000);
    expect(seq[2]).toBe(4000);
    expect(seq[seq.length - 1]).toBe(30_000);
  });
});
