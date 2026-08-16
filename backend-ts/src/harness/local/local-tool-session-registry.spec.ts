import { describe, expect, it, vi } from 'vitest';
import { LocalToolSessionRegistry } from './local-tool-session-registry.js';
import type { SessionMapper, StreamingWsRegistry } from '../deps.js';

describe('LocalToolSessionRegistry', () => {
  it('resolvesUserFromMemorySessionRecordAndParentSession', async () => {
    const wsRegistry = { hasLocalClientConnection: vi.fn(), sendToLocalClients: vi.fn() } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper & { selectById: ReturnType<typeof vi.fn> };
    const registry = new LocalToolSessionRegistry(wsRegistry, sessionMapper);

    registry.setUserForSession(1, 7);
    wsRegistry.hasLocalClientConnection.mockReturnValue(true);
    expect(await registry.getUserIdForSession(1)).toBe(7);
    expect(await registry.isConnected(1)).toBe(true);

    sessionMapper.selectById.mockResolvedValueOnce({ id: 2, userId: 8 });
    wsRegistry.hasLocalClientConnection.mockReturnValue(false);
    expect(await registry.getUserIdForSession(2)).toBe(8);
    expect(await registry.isConnected(2)).toBe(false);

    sessionMapper.selectById.mockResolvedValueOnce({ id: 3, sessionType: 'SUBAGENT', parentSessionId: 1 });
    expect(await registry.getUserIdForSession(3)).toBe(7);
    expect(await registry.getUserIdForSession(null)).toBeNull();
  });

  it('sendsCompletesAndFailsPendingToolRequests', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn().mockReturnValue(true),
      sendToLocalClients: vi.fn(),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper;
    const registry = new LocalToolSessionRegistry(wsRegistry, sessionMapper);
    registry.setUserForSession(10, 7);

    const pending = await registry.sendToolRequest(10, 'read_file', '{"path":"a"}', '/repo', true, 'danger');
    expect(wsRegistry.sendToLocalClients).toHaveBeenCalled();
    const event = wsRegistry.sendToLocalClients.mock.calls[0][1] as { data: Record<string, unknown> };
    expect(pending.requestId).toBe(event.data.requestId);
    expect(event.data.dangerReason).toBe('danger');

    registry.completeToolRequest(10, pending.requestId!, '{"ok":true}');
    expect(await pending.future).toBe('{"ok":true}');

    const errorPending = await registry.sendToolRequest(10, 'shell', null as unknown as string, null, false, null);
    const errorEvent = wsRegistry.sendToLocalClients.mock.calls[1][1] as { data: Record<string, unknown> };
    registry.completeToolRequestError(10, String(errorEvent.data.requestId), 'bad "thing"');
    expect(await errorPending.future).toContain("bad 'thing'");
  });

  it('timeoutFailsOnlyMatchingRequestLeavingSiblingPending', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn().mockReturnValue(true),
      sendToLocalClients: vi.fn(),
    } as unknown as StreamingWsRegistry;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    registry.setUserForSession(10, 7);
    const first = await registry.sendToolRequest(10, 'read_file', '{}', '/repo', false, null);
    const second = await registry.sendToolRequest(10, 'shell', '{}', '/repo', false, null);
    registry.completeToolRequestError(10, first.requestId!, 'Local tool execution timed out after 1 seconds');
    expect(await first.future).toContain('timed out');
    let secondDone = false;
    void second.future.then(() => { secondDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false);
    registry.completeToolRequest(10, second.requestId!, '{"ok":true}');
    expect(await second.future).toBe('{"ok":true}');
  });

  it('unregisteredOrDisconnectedSessionsReturnErrorAndReregistrationFailsPending', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn().mockReturnValue(true),
      sendToLocalClients: vi.fn(),
    } as unknown as StreamingWsRegistry;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    expect(await (await registry.sendToolRequest(1, 'tool', '{}', null, false, null)).future).toContain('not connected');

    registry.setUserForSession(1, 7);
    const pending = await registry.sendToolRequest(1, 'tool', '{}', null, false, null);
    registry.setUserForSession(1, 8);
    expect(await pending.future).toContain('re-registered');

    registry.setUserForSession(2, 8);
    const pendingForUser = await registry.sendToolRequest(2, 'tool', '{}', null, false, null);
    registry.failAllForUser(8);
    expect(await pendingForUser.future).toContain('User disconnected');

    registry.setUserForSession(3, 9);
    const pendingForSession = await registry.sendToolRequest(3, 'tool', '{}', null, false, null);
    registry.removeSession(3);
    expect(await pendingForSession.future).toContain('Session unregistered');
    registry.completeToolRequest(3, 'missing', '{}');
    registry.completeToolRequestError(3, 'missing', 'err');
    registry.failAllForSession(3);
  });
});
