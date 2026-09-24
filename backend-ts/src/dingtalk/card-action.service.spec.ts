import { describe, expect, it, vi } from 'vitest';
import { DingtalkCardActionService } from './card-action.service.js';
import type { DingtalkInboundQueueRow } from './types.js';

function row(overrides: Partial<DingtalkInboundQueueRow> = {}): DingtalkInboundQueueRow {
  return {
    id: 4, botId: 1, sessionId: 8, messageId: 'm', outTrackId: 'track-q', senderUserid: 'staff-a',
    maoUserId: 3, rankNo: 2, status: 'QUEUED', payload: JSON.stringify({ context: { text: '排队内容' } }),
    ...overrides,
  };
}

function service(options: Partial<ConstructorParameters<typeof DingtalkCardActionService>[0]> = {}) {
  const queuePort = {
    findByOutTrackId: vi.fn(async () => null as DingtalkInboundQueueRow | null),
    findById: vi.fn(async () => null),
    jumpToFront: vi.fn(async () => true),
    cancel: vi.fn(async () => 'CANCELLED' as const),
    ...(options.queuePort ?? {}),
  };
  const built = new DingtalkCardActionService({
    findProgress: async () => null,
    interruptAndDrain: vi.fn(),
    cancelRunning: vi.fn(async () => true),
    ...options,
    queuePort,
  });
  return { service: built, queuePort };
}

describe('DingtalkCardActionService', () => {
  it('rejects a button click from someone other than the sender', async () => {
    const { service: actions } = service({
      queuePort: { findByOutTrackId: async () => row(), findById: async () => row(), jumpToFront: async () => true, cancel: async () => 'CANCELLED' },
    });
    const decision = await actions.decide({
      outTrackId: 'track-q', userId: 'other', content: JSON.stringify({ cardPrivateData: { actionIds: ['run'], params: { senderUserid: 'staff-a' } } }),
    });
    expect(JSON.stringify(decision?.response)).toContain('仅消息发送者可操作');
    expect(decision?.after).toBeUndefined();
  });

  it('jumps a queued message to the front and cancels only that queued item', async () => {
    const interruptAndDrain = vi.fn();
    const jumpToFront = vi.fn(async () => true);
    const cancel = vi.fn(async () => 'CANCELLED' as const);
    const { service: actions } = service({
      interruptAndDrain,
      queuePort: { findByOutTrackId: async (id: string) => id === 'track-q' ? row() : null, findById: async () => row(), jumpToFront, cancel },
    });
    const run = await actions.decide({
      outTrackId: 'track-q', userId: 'staff-a', content: { cardPrivateData: { actionIds: ['run'], params: {} } },
    });
    expect(jumpToFront).toHaveBeenCalledWith(4);
    expect(run?.after).toBeTypeOf('function');
    await run?.after?.();
    expect(interruptAndDrain).toHaveBeenCalledWith(8);
    const dropped = await actions.decide({
      outTrackId: 'track-q', userId: 'staff-a', content: { cardPrivateData: { actionIds: ['cancel'], params: {} } },
    });
    expect(cancel).toHaveBeenCalledWith(4);
    expect(dropped?.after).toBeUndefined();
    expect(JSON.stringify(dropped?.response)).toContain('cancelled');
  });

  it('returns cancelled progress variables for the original sender', async () => {
    const cancelRunning = vi.fn(async () => true);
    const { service: actions } = service({
      cancelRunning,
      findProgress: async () => ({ sessionId: 8, botId: 1, outTrackId: 'track-p', chatType: 'p2p', conversationId: 'cid', senderUserid: 'staff-a' }),
    });
    const decision = await actions.decide({
      outTrackId: 'track-p', userId: 'staff-a', content: { cardPrivateData: { actionIds: ['cancel'], params: { senderUserid: 'staff-a', sessionId: '8' } } },
    });
    expect(cancelRunning).toHaveBeenCalledWith(8);
    expect(JSON.stringify(decision?.response)).toContain('任务已取消');
  });

  it('does not start a retry when the session is no longer failed', async () => {
    const retryFailed = vi.fn(async () => ({ ok: true as const }));
    const { service: actions } = service({
      retryFailed,
      getPhase: async () => 'COMPLETED',
      findProgress: async () => ({ sessionId: 8, botId: 1, outTrackId: 'track-p', chatType: 'p2p', conversationId: 'cid', senderUserid: 'staff-a' }),
    });
    const decision = await actions.decide({
      outTrackId: 'track-p', userId: 'staff-a', content: { cardPrivateData: { actionIds: ['retry'], params: { senderUserid: 'staff-a' } } },
    });
    expect(retryFailed).not.toHaveBeenCalled();
    expect(decision?.after).toBeUndefined();
    expect(JSON.stringify(decision?.response)).toContain('任务已结束，无法重试');
  });
});
