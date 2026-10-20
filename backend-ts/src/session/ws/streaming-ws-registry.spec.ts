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
});
