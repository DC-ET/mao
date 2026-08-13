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

  it('reportsFailureWhenAllWritesFail', async () => {
    const session = mockSocket('ws-2', () => { throw new Error('closed'); });
    registry.register(session, 1, 'electron');
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'FAILED' }));
    expect(result.failureCount).toBe(1);
    expect(result.successCount).toBe(0);
  });
});
