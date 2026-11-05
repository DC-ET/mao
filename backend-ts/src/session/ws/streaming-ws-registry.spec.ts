import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from './streaming-ws-registry.js';
import { wsEvent } from './ws-event.js';

function mockSocket(id: string, sendImpl?: (data: string) => void): WsSocket {
  return {
    id,
    readyState: WS_OPEN,
    send: sendImpl ?? vi.fn(),
    close: vi.fn(),
  };
}

describe('StreamingWsRegistry', () => {
  let registry: StreamingWsRegistry;

  beforeEach(() => {
    registry = new StreamingWsRegistry(10);
  });

  afterEach(() => {
    registry.shutdown();
  });

  it('reportsNoDeliveryWithoutConnections', async () => {
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    expect(result.successCount).toBe(0);
    expect(result.targetCount).toBe(0);
  });

  it('reportsSuccessWhenAnyOpenConnectionAcceptsMessage', async () => {
    const session = mockSocket('ws-1');
    registry.register(session, 1, 'electron');
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    expect(result.successCount).toBe(1);
  });

  it('tracks the current session execution id until cleared', () => {
    expect(registry.getSessionExecution(10)).toBeUndefined();
    registry.setSessionExecution(10, 'exec-1');
    expect(registry.getSessionExecution(10)).toBe('exec-1');
    registry.setSessionExecution(10, 'exec-2');
    expect(registry.getSessionExecution(10)).toBe('exec-2');
    registry.clearSessionExecution(10);
    expect(registry.getSessionExecution(10)).toBeUndefined();
  });

  it('snapshots active tool calls until completion', () => {
    registry.trackActiveToolCall(10, 'exec-1', 'call-1', 'shell', '{"command":"npm test"}');
    registry.updateActiveToolCallArguments(10, 'call-1', '{"command":"npm run test"}');

    expect(registry.getActiveToolCalls(10)).toEqual([expect.objectContaining({
      tool_call_id: 'call-1',
      arguments: '{"command":"npm run test"}',
      executionId: 'exec-1',
    })]);

    registry.completeActiveToolCall(10, 'call-1');
    expect(registry.getActiveToolCalls(10)).toEqual([]);
  });

  it('reportsFailureWhenAllWritesFail', async () => {
    const session = mockSocket('ws-2', () => { throw new Error('closed'); });
    registry.register(session, 1, 'electron');
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'FAILED' }));
    expect(result.failureCount).toBe(1);
    expect(result.successCount).toBe(0);
  });

  it('treats cli as a distinct client type and a local executor', async () => {
    const send = vi.fn();
    const session = mockSocket('ws-cli', send);
    registry.register(session, 3, 'cli');
    expect(registry.hasLocalClientConnection(3)).toBe(true);
    registry.sendToLocalClients(3, wsEvent('tool_execute', 10, { requestId: 'r' }));
    expect(send).toHaveBeenCalled();
    const delivered = await registry.sendWithResult(3, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    expect(delivered.successCount).toBe(1);
  });

  it('does not treat browser as a local executor', async () => {
    const send = vi.fn();
    const session = mockSocket('ws-browser', send);
    registry.register(session, 4, 'browser');
    expect(registry.hasLocalClientConnection(4)).toBe(false);
    registry.sendToLocalClients(4, wsEvent('tool_execute', 10, { requestId: 'r' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers terminal frames even when the delta queue is saturated', async () => {
    const session = mockSocket('ws-full');
    registry.register(session, 9, 'electron');
    // 塞满普通队列（capacity=10）：此后增量帧应被丢弃
    for (let i = 0; i < 20; i++) {
      registry.send(9, wsEvent('content_delta', 10, { delta: `chunk-${i}` }));
    }
    const sent = (session.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => JSON.parse(String(c[0])).type);
    expect(sent).not.toContain('chunk-19');
    expect(registry.getOutboundQueueSize()).toBeLessThanOrEqual(10);

    // 终态帧仍须送达：客户端等待方靠它收敛执行态
    registry.send(9, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    const after = (session.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => JSON.parse(String(c[0])).type);
    expect(after).toContain('session_status');
    expect(after[after.length - 1]).toBe('session_status');

    const result = await registry.sendWithResult(9, wsEvent('message_end', 10, {}));
    expect(result.successCount).toBe(1);
  });

  it('resolves pending tracked events on shutdown instead of hanging', async () => {
    let resolved: unknown = null;
    const pending = registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'COMPLETED' })).then((r) => { resolved = r; });
    registry.shutdown();
    await pending;
    expect(resolved).toEqual({ targetCount: 0, successCount: 0, failureCount: 0 });
  });

  describe('页面操作能力声明（pageEnabled）', () => {
    it('缺省注册按开启：绑定 embed 会话后 isEmbedPageSession 为 true', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed');
      registry.bindEmbedSession(10, socket);
      expect(registry.getPageEnabled(socket)).toBe(true);
      expect(registry.isEmbedPageSession(10)).toBe(true);
    });

    it('pageEnabled=false 注册：isEmbedPageSession 为 false，但 isEmbedSession 仍为 true', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed', undefined, false);
      registry.bindEmbedSession(10, socket);
      expect(registry.getPageEnabled(socket)).toBe(false);
      // 连接仍是 embed 会话（用于事件投递），只是页面能力关闭
      expect(registry.isEmbedSession(10)).toBe(true);
      expect(registry.isEmbedPageSession(10)).toBe(false);
    });

    it('连接非 OPEN 时一律收敛为 false（即使声明过开启）', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed');
      registry.bindEmbedSession(10, socket);
      socket.readyState = 2; // CLOSING
      expect(registry.isEmbedPageSession(10)).toBe(false);
    });

    it('未注册连接按开启缺省：getPageEnabled 返回 true', () => {
      expect(registry.getPageEnabled(mockSocket('ws-unknown'))).toBe(true);
    });

    it('unregister 后能力声明随连接清理，isEmbedPageSession 回落 false', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed');
      registry.bindEmbedSession(10, socket);
      expect(registry.isEmbedPageSession(10)).toBe(true);
      registry.unregister(socket);
      expect(registry.isEmbedPageSession(10)).toBe(false);
      expect(registry.getPageEnabled(socket)).toBe(true);
    });

    it('重连重新声明：同一 socket 再次 register 覆盖上次的 pageEnabled', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed', undefined, false);
      registry.bindEmbedSession(10, socket);
      expect(registry.isEmbedPageSession(10)).toBe(false);
      // 重连后宿主改为开启：auth 首帧重新声明
      registry.register(socket, 1, 'embed', undefined, true);
      expect(registry.getPageEnabled(socket)).toBe(true);
      expect(registry.isEmbedPageSession(10)).toBe(true);
    });
  });

  it('registersDeviceIdentityAndRoutesToTheLatestConnectionPerDevice', () => {
    const first = mockSocket('ws-1');
    const second = mockSocket('ws-2');
    registry.register(first, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    expect(registry.getDeviceId(first)).toBe('dev-a');
    expect(registry.getDeviceInfo(first)).toEqual({ id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    expect(registry.getDevice(7, 'dev-a')).toEqual({ id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-a']);

    // 同 deviceId 覆盖为最新连接：只向新连接投递，避免同机多窗口重复执行
    registry.register(second, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    const result = registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, { requestId: 'r1' }));
    expect(result).toMatchObject({ targetCount: 1, successCount: 1 });
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalled();

    // 旧连接断开不清掉新连接；新连接断开后设备才离线
    registry.unregister(first);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    registry.unregister(second);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
    expect(registry.getOnlineDeviceIds(7)).toEqual([]);
  });

  it('doesNotRegisterDeviceForNonLocalClientsAndReturnsEmptyDelivery', () => {
    const browser = mockSocket('ws-browser');
    registry.register(browser, 7, 'browser', undefined, true, { id: 'dev-fake', name: 'x', platform: 'linux' });
    expect(registry.getDeviceId(browser)).toBeNull();
    expect(registry.hasDeviceConnection(7, 'dev-fake')).toBe(false);
    const missing = registry.sendToDevice(7, 'dev-none', wsEvent('tool_execute', 10, {}));
    expect(missing).toEqual({ targetCount: 0, successCount: 0, failureCount: 0 });
  });

  it('replacesDeviceMappingWhenSameSocketReauthsWithNewDevice', () => {
    const socket = mockSocket('ws-1');
    registry.register(socket, 7, 'electron', undefined, true, { id: 'dev-a', name: 'A', platform: 'darwin' });
    registry.register(socket, 7, 'electron', undefined, true, { id: 'dev-b', name: 'B', platform: 'darwin' });
    expect(registry.getDeviceId(socket)).toBe('dev-b');
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
    expect(registry.hasDeviceConnection(7, 'dev-b')).toBe(true);
  });

  // 同机多窗口 / 多个 CLI 进程共用同一 deviceId（技术方案 2026-11-05 D4）：
  // 执行连接断开必须回落另一条存活连接，否则设备被整体误判离线（定向投递 / 在线态 / failAllForDevice 全失真）。
  it('fallsBackToRemainingConnectionWhenExecutorDisconnects', () => {
    const first = mockSocket('ws-1');
    const second = mockSocket('ws-2');
    registry.register(first, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    registry.register(second, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });

    registry.unregister(second);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-a']);
    const result = registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, { requestId: 'r1' }));
    expect(result).toMatchObject({ targetCount: 1, successCount: 1 });
    expect(first.send).toHaveBeenCalled();

    // 设备最后一条连接也断开后才算离线
    registry.unregister(first);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
    expect(registry.getOnlineDeviceIds(7)).toEqual([]);
  });

  it('keepsNewerExecutorWhenStaleSameDeviceConnectionCloses', () => {
    const first = mockSocket('ws-1');
    const second = mockSocket('ws-2');
    registry.register(first, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    registry.register(second, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    // 旧连接（非执行连接）断开：不得回落到它，执行连接仍是 second
    registry.unregister(first);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, {}));
    expect(second.send).toHaveBeenCalled();
  });
});
