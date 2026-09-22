import { describe, expect, it, vi } from 'vitest';
import { persistFeishuCancelIfIdle } from './cancel-running.js';

describe('persistFeishuCancelIfIdle', () => {
  it('does not persist CANCELLED while an AgentLoop is still running', async () => {
    const persist = vi.fn(async () => true);
    const drain = vi.fn(async () => undefined);
    const cancelled = await persistFeishuCancelIfIdle({
      sessionId: 7,
      hadLoop: true,
      persistCancelledIfActive: persist,
      drainNextIfPending: drain,
    });
    expect(cancelled).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('persists and drains only when no loop is registered and the session was active', async () => {
    const persist = vi.fn(async () => true);
    const drain = vi.fn(async () => undefined);
    const cancelled = await persistFeishuCancelIfIdle({
      sessionId: 7,
      hadLoop: false,
      persistCancelledIfActive: persist,
      drainNextIfPending: drain,
    });
    expect(cancelled).toBe(true);
    expect(persist).toHaveBeenCalledWith(7);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(7));
  });

  it('does not drain when the session was not running', async () => {
    const drain = vi.fn(async () => undefined);
    const cancelled = await persistFeishuCancelIfIdle({
      sessionId: 7,
      hadLoop: false,
      persistCancelledIfActive: async () => false,
      drainNextIfPending: drain,
    });
    expect(cancelled).toBe(false);
    expect(drain).not.toHaveBeenCalled();
  });
});