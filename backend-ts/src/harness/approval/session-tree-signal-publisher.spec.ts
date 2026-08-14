import { describe, expect, it, vi } from 'vitest';
import { SessionTreeSignalPublisher } from './session-tree-signal-publisher.js';

describe('SessionTreeSignalPublisher', () => {
  it('dropsStalePublishWhenANewerOneStarts', async () => {
    let releaseFirst!: () => void;
    const firstLookup = new Promise<void>((r) => { releaseFirst = r; });
    let lookups = 0;
    const sessionMapper = {
      selectById: vi.fn(async (id: number) => {
        lookups += 1;
        if (lookups === 1) await firstLookup;
        return { id, userId: 7, phase: lookups === 1 ? 'WAITING_APPROVAL' : 'RUNNING', unread: 0 };
      }),
      listSideTasks: vi.fn(async () => []),
    };
    const approvalRegistry = { countForSessionIds: vi.fn(() => new Map()) };
    const askUserQuestionsRegistry = { countPendingBySessionIds: vi.fn(() => new Map()) };
    const streamingWsRegistry = { send: vi.fn() };
    const publisher = new SessionTreeSignalPublisher(
      sessionMapper as never,
      approvalRegistry as never,
      askUserQuestionsRegistry as never,
      streamingWsRegistry as never,
    );

    const first = publisher.publish(10);
    const second = publisher.publish(10);
    releaseFirst();
    await Promise.all([first, second]);

    expect(streamingWsRegistry.send).toHaveBeenCalledTimes(1);
    expect(streamingWsRegistry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_tree_status',
      sessionId: 10,
      data: expect.objectContaining({ treePendingApprovalCount: 0, treeRunning: true }),
    }));
  });
});
