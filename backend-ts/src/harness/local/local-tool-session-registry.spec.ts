import { describe, expect, it, vi } from 'vitest';
import { LocalToolSessionRegistry } from './local-tool-session-registry.js';
import type { SessionMapper, StreamingWsRegistry } from '../deps.js';

describe('LocalToolSessionRegistry', () => {
  it('resolvesUserFromMemorySessionRecordAndParentSession', async () => {
    const wsRegistry = { hasLocalClientConnection: vi.fn(), sendToLocalClients: vi.fn() } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const sessionMapper = { selectById: vi.fn() } as unknown as SessionMapper & { selectById: ReturnType<typeof vi.fn> };
    const registry = new LocalToolSessionRegistry(wsRegistry, sessionMapper);

    registry.setTargetForSession(1, 7);
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
    registry.setTargetForSession(10, 7);

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
    registry.setTargetForSession(10, 7);
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
    expect(await (await registry.sendToolRequest(1, 'tool', '{}', null, false, null)).future).toContain('本地执行端未连接');

    registry.setTargetForSession(1, 7);
    const pending = await registry.sendToolRequest(1, 'tool', '{}', null, false, null);
    registry.setTargetForSession(1, 8);
    expect(await pending.future).toContain('re-registered');

    registry.setTargetForSession(2, 8);
    const pendingForUser = await registry.sendToolRequest(2, 'tool', '{}', null, false, null);
    registry.failAllForUser(8);
    expect(await pendingForUser.future).toContain('User disconnected');

    registry.setTargetForSession(3, 9);
    const pendingForSession = await registry.sendToolRequest(3, 'tool', '{}', null, false, null);
    registry.removeSession(3);
    expect(await pendingForSession.future).toContain('Session unregistered');
    registry.completeToolRequest(3, 'missing', '{}');
    registry.completeToolRequestError(3, 'missing', 'err');
    registry.failAllForSession(3);
  });

  it('toolExecutePayloadCarriesApprovalHintOnlyWhenPresent', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn().mockReturnValue(true),
      sendToLocalClients: vi.fn(),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    registry.setTargetForSession(10, 7);

    const hint = { ruleType: 'SHELL_PREFIX' as const, ruleValue: 'npm run', label: '本会话总是允许以 npm run 开头的命令' };
    await registry.sendToolRequest(10, 'shell', '{"command":"npm run build"}', null, true, null, hint);
    const withHint = wsRegistry.sendToLocalClients.mock.calls[0][1] as { data: Record<string, unknown> };
    expect(withHint.data.approvalHint).toEqual(hint);

    await registry.sendToolRequest(10, 'shell', '{}', null, true, null);
    const withoutHint = wsRegistry.sendToLocalClients.mock.calls[1][1] as { data: Record<string, unknown> };
    expect('approvalHint' in withoutHint.data).toBe(false);
  });

  it('routesToBoundDeviceAndChecksDeviceReachability', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn().mockReturnValue(true),
      hasDeviceConnection: vi.fn().mockReturnValue(true),
      sendToLocalClients: vi.fn(),
      sendToDevice: vi.fn(),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    registry.setTargetForSession(10, 7, 'dev-a');
    expect(await registry.isConnected(10)).toBe(true);
    expect(wsRegistry.hasDeviceConnection).toHaveBeenCalledWith(7, 'dev-a');

    await registry.sendToolRequest(10, 'read_file', '{}', '/repo', false, null);
    expect(wsRegistry.sendToDevice).toHaveBeenCalledWith(7, 'dev-a', expect.objectContaining({ type: 'tool_execute' }));
    expect(wsRegistry.sendToLocalClients).not.toHaveBeenCalled();

    wsRegistry.hasDeviceConnection.mockReturnValue(false);
    expect(await registry.isConnected(10)).toBe(false);
    const offline = await registry.sendToolRequest(10, 'shell', '{}', null, false, null);
    expect(await offline.future).toContain('本地执行端未连接');
  });

  it('keepsExistingDeviceBindingWhenTargetIsRefreshedWithNull', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn(() => true),
      hasDeviceConnection: vi.fn(() => true),
      sendToLocalClients: vi.fn(),
      sendToDevice: vi.fn(),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    registry.setTargetForSession(10, 7, 'dev-a');
    registry.setTargetForSession(10, 7, null);
    await registry.sendToolRequest(10, 'read_file', '{}', '/repo', false, null);
    expect(wsRegistry.sendToDevice).toHaveBeenCalledWith(7, 'dev-a', expect.anything());
    expect(wsRegistry.sendToLocalClients).not.toHaveBeenCalled();
  });

  it('failsOnlyRequestsBoundToDisconnectedDevice', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn(() => true),
      hasDeviceConnection: vi.fn(() => true),
      sendToLocalClients: vi.fn(),
      sendToDevice: vi.fn(),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    registry.setTargetForSession(10, 7, 'dev-a');
    registry.setTargetForSession(11, 7, 'dev-b');
    const a = await registry.sendToolRequest(10, 'tool', '{}', null, false, null);
    const b = await registry.sendToolRequest(11, 'tool', '{}', null, false, null);
    registry.failAllForDevice(7, 'dev-a');
    expect(await a.future).toContain('Device disconnected');
    let bDone = false;
    void b.future.then(() => { bDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(bDone).toBe(false);
    registry.completeToolRequest(11, b.requestId!, '{"ok":true}');
    expect(await b.future).toBe('{"ok":true}');
  });

  it('failsOnlyRequestsDispatchedToTheClosingSocket', async () => {
    const socketA = { id: 'ws-a' };
    const socketB = { id: 'ws-b' };
    let executor: { id: string } | null = socketA;
    const wsRegistry = {
      hasLocalClientConnection: vi.fn(() => true),
      hasDeviceConnection: vi.fn(() => true),
      sendToLocalClients: vi.fn(),
      sendToDevice: vi.fn(),
      getDeviceExecutorSocket: vi.fn(() => executor),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const registry = new LocalToolSessionRegistry(wsRegistry, { selectById: vi.fn() } as unknown as SessionMapper);
    registry.setTargetForSession(10, 7, 'dev-a');

    const onA = await registry.sendToolRequest(10, 'read_file', '{}', '/repo', false, null);
    // 执行连接交接给同设备新连接 B：之后的请求下发到 B
    executor = socketB;
    const onB = await registry.sendToolRequest(10, 'shell', '{}', '/repo', false, null);

    // B 断开只失败 B 上的请求；A 上在途的请求仍在执行，不能被误杀
    registry.failAllForSocket(socketB);
    expect(await onB.future).toContain('Device disconnected');
    let aDone = false;
    void onA.future.then(() => { aDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(aDone).toBe(false);

    // A 断开后其请求才失败
    registry.failAllForSocket(socketA);
    expect(await onA.future).toContain('Device disconnected');
  });

  it('resolvesBoundDeviceFromDbWhenMemoryIsEmpty', async () => {
    const wsRegistry = {
      hasLocalClientConnection: vi.fn(() => false),
      hasDeviceConnection: vi.fn(() => true),
      sendToLocalClients: vi.fn(),
      sendToDevice: vi.fn(),
    } as unknown as StreamingWsRegistry & Record<string, ReturnType<typeof vi.fn>>;
    const sessionMapper = { selectById: vi.fn(async () => ({ id: 20, userId: 7, targetDeviceId: 'dev-db' })) };
    const registry = new LocalToolSessionRegistry(wsRegistry, sessionMapper as unknown as SessionMapper);
    expect(await registry.isConnected(20)).toBe(true);
    await registry.sendToolRequest(20, 'tool', '{}', null, false, null);
    expect(wsRegistry.sendToDevice).toHaveBeenCalledWith(7, 'dev-db', expect.anything());
    expect(wsRegistry.sendToLocalClients).not.toHaveBeenCalled();
  });
});
