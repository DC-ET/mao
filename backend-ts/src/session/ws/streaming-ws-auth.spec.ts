import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from './streaming-ws-handler.js';
import { StreamingWsRegistry, WS_OPEN, type WsAuthMetadata, type WsSocket } from './streaming-ws-registry.js';
import { wsEvent } from './ws-event.js';

const NOW = 1_800_000_000_000;
function socket(id = 'sso'): WsSocket {
  return { id, readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
}

describe('WS SSO authentication lifecycle', () => {
  let registry: StreamingWsRegistry;
  let handler: StreamingWsHandler;
  let ws: WsSocket;
  let metadata: Map<string, WsAuthMetadata>;
  let jwtService: { getAccessTokenMetadata: ReturnType<typeof vi.fn>; getTokenType: ReturnType<typeof vi.fn> };
  const requestCancel = vi.fn();
  const failAllForUser = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    registry = new StreamingWsRegistry();
    ws = socket();
    metadata = new Map([
      ['old', { userId: 7, authSource: 'company_sso', expiresAt: NOW + 1000 }],
      ['new', { userId: 7, authSource: 'company_sso', expiresAt: NOW + 5000 }],
    ]);
    jwtService = {
      getAccessTokenMetadata: vi.fn((token: string) => metadata.get(token) ?? null),
      getTokenType: vi.fn(() => 'access'),
    };
    handler = new StreamingWsHandler({
      registry, jwtService, agentLoop: { requestCancel },
      localToolSessionRegistry: { failAllForUser },
      embedPageToolRegistry: { failSession: vi.fn(), complete: vi.fn(() => true) },
    } as unknown as WsHandlerDeps);
  });

  afterEach(() => {
    registry.shutdown();
    vi.useRealTimers();
  });

  async function auth(token = 'old', target = ws) {
    await handler.handleTextMessage(target, JSON.stringify({ type: 'auth', token, client: 'embed' }));
  }

  async function refresh(token = 'new', requestId = 'r1') {
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'auth_refresh', requestId, token }));
  }

  it('acknowledges initial auth only on its own connection and refreshes without losing stream state', async () => {
    const peer = socket('peer');
    registry.register(peer, 7, 'browser');
    await auth();
    expect(JSON.parse(vi.mocked(ws.send).mock.calls[0]![0]).type).toBe('connected');
    expect(peer.send).not.toHaveBeenCalled();
    registry.subscribe(7, 11);
    registry.trackActiveToolCall(11, 'exec', 'tool', 'shell', '{}');
    await refresh();
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'auth_refreshed', requestId: 'r1', expiresAt: NOW + 5000 }));
    expect(registry.isSubscribed(7, 11)).toBe(true);
    expect(registry.getActiveToolCalls(11)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1003, 'Authentication expired');
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it('replays duplicate request IDs without replacing a later authentication or revalidating expired credentials', async () => {
    await auth();
    await refresh();
    metadata.set('later', { userId: 7, authSource: 'company_sso', expiresAt: NOW + 9000 });
    await refresh('later', 'r2');
    metadata.delete('new');
    const validations = jwtService.getAccessTokenMetadata.mock.calls.length;
    await refresh();
    expect(jwtService.getAccessTokenMetadata).toHaveBeenCalledTimes(validations);
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'auth_refreshed', requestId: 'r1', expiresAt: NOW + 5000 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it.each(['invalid', 'other-user', 'other-source', 'expired', 'shell', 'refresh'])('rejects %s refresh without changing authentication', async (kind) => {
    await auth();
    const candidate = { userId: 7, authSource: 'company_sso', expiresAt: NOW + 5000 };
    if (kind === 'other-user') candidate.userId = 8;
    if (kind === 'other-source') candidate.authSource = 'password';
    if (kind === 'expired') candidate.expiresAt = NOW;
    if (kind !== 'invalid') metadata.set(kind, candidate);
    if (kind === 'shell' || kind === 'refresh') jwtService.getTokenType.mockReturnValue(kind);
    await refresh(kind);
    expect(ws.close).toHaveBeenCalledWith(1003, 'Invalid auth refresh');
    expect(registry.getRefreshResult(ws, 'r1')).toBeUndefined();
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it.each([{}, { requestId: '', token: 'new' }, { requestId: 'r', token: 123 }])('rejects malformed refresh %j', async (frame) => {
    await auth();
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'auth_refresh', ...frame }));
    expect(ws.close).toHaveBeenCalledWith(1003, 'Invalid auth refresh');
  });

  it('rejects refresh before initial auth', async () => {
    await refresh();
    expect(ws.close).toHaveBeenCalledWith(1003, 'Not authenticated');
    expect(jwtService.getAccessTokenMetadata).not.toHaveBeenCalled();
  });

  it.each(['send_message', 'cancel', 'auth_refresh', 'ping'])('blocks expired inbound %s even before the timer runs', async (type) => {
    await auth();
    vi.mocked(ws.send).mockClear();
    vi.setSystemTime(NOW + 1000);
    await handler.handleTextMessage(ws, JSON.stringify({ type, token: 'new', requestId: 'r', sessionId: 11 }));
    expect(ws.close).toHaveBeenCalledWith(1003, 'Authentication expired');
    expect(ws.send).not.toHaveBeenCalled();
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it.each(['send', 'raw', 'local', 'result', 'direct'])('blocks expired outbound %s but still delivers to valid peers', async (path) => {
    await auth();
    const peer = socket('peer');
    registry.register(peer, 7, 'electron');
    const local = socket('sso-local');
    registry.register(local, 7, 'electron', metadata.get('old'));
    vi.mocked(ws.send).mockClear();
    vi.setSystemTime(NOW + 1000);
    const event = wsEvent('session_status', 11, { phase: 'COMPLETED' });
    if (path === 'send') registry.send(7, event);
    if (path === 'raw') {
      registry.sendRaw(7, JSON.stringify(event));
      await vi.advanceTimersByTimeAsync(50);
    }
    if (path === 'local') registry.sendToLocalClients(7, event);
    if (path === 'result') expect(await registry.sendWithResult(7, event)).toEqual({ targetCount: 1, successCount: 1, failureCount: 0 });
    if (path === 'direct') registry.sendToConnection(ws, event);
    expect(ws.send).not.toHaveBeenCalled();
    expect(local.send).not.toHaveBeenCalled();
    if (path !== 'direct') expect(peer.send).toHaveBeenCalledOnce();
  });

  it('keeps legacy non-SSO access and shell connections alive beyond token expiry', async () => {
    metadata.set('legacy', { userId: 7, expiresAt: NOW + 1000 });
    jwtService.getTokenType.mockReturnValue('shell');
    await auth('legacy');
    await vi.advanceTimersByTimeAsync(2000);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'ping' }));
    expect(ws.close).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(ws.send).mock.lastCall![0]).type).toBe('pong');
  });

  it('checks queued raw delivery even when expiry callbacks are delayed', async () => {
    await auth();
    vi.mocked(ws.send).mockClear();
    registry.sendRaw(7, '{"type":"chunk"}');
    vi.setSystemTime(NOW + 1000);
    // 驱动 drain，而不是运行定时器：证明 raw 的 deliver 入口独立检查到期。
    registry.send(7, wsEvent('pong', null, {}));
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1003, 'Authentication expired');
  });

  it('rejects late frames even if the transport has not completed closing', async () => {
    await auth();
    await refresh('invalid');
    await auth('new');
    expect(jwtService.getAccessTokenMetadata).toHaveBeenCalledTimes(2);
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it.each(['close', 'error', 'shutdown'])('cleans authentication timers on %s', async (kind) => {
    await auth();
    await refresh();
    expect(vi.getTimerCount()).toBe(2);
    if (kind === 'close') handler.afterConnectionClosed(ws);
    if (kind === 'error') handler.handleTransportError(ws);
    if (kind === 'shutdown') registry.shutdown();
    expect(vi.getTimerCount()).toBe(kind === 'shutdown' ? 0 : 1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(requestCancel).not.toHaveBeenCalled();
  });
});
