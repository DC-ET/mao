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
});
