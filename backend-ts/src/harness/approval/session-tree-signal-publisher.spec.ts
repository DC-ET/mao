import { describe, expect, it, vi } from 'vitest';
import { SessionTreeSignalPublisher } from './session-tree-signal-publisher.js';

function makePublisher(mapper: Record<string, unknown>) {
  const approvalRegistry = { countForSessionIds: vi.fn(() => new Map()) };
  const askUserQuestionsRegistry = {
    countPendingBySessionIds: vi.fn(() => new Map()),
    getPendingForSession: vi.fn(() => []),
  };
  const streamingWsRegistry = { send: vi.fn() };
  const publisher = new SessionTreeSignalPublisher(
    mapper as never,
    approvalRegistry as never,
    askUserQuestionsRegistry as never,
    streamingWsRegistry as never,
  );
  return { publisher, streamingWsRegistry };
}

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
      listDescendantSideTasks: vi.fn(async () => []),
    };
    const { publisher, streamingWsRegistry } = makePublisher(sessionMapper);

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

  it('publishIfSideTaskConvergesToRootAndAggregatesAllDescendants', async () => {
    const sessionMapper = {
      selectById: vi.fn(async (id: number) => {
        if (id === 30) return { id: 30, userId: 7, sessionType: 'SIDE_TASK', parentSessionId: 20, phase: 'RUNNING', unread: 0 };
        if (id === 20) return { id: 20, userId: 7, sessionType: 'SIDE_TASK', parentSessionId: 10, phase: 'IDLE', unread: 0 };
        return { id: 10, userId: 7, sessionType: 'NORMAL', parentSessionId: null, phase: 'IDLE', unread: 0 };
      }),
      // 深层任务在列：聚合必须计入树-running
      listDescendantSideTasks: vi.fn(async (rootId: number) => {
        expect(rootId).toBe(10);
        return [
          { id: 20, userId: 7, sessionType: 'SIDE_TASK', parentSessionId: 10, phase: 'IDLE', unread: 0 },
          { id: 30, userId: 7, sessionType: 'SIDE_TASK', parentSessionId: 20, phase: 'RUNNING', unread: 1 },
        ];
      }),
    };
    const { publisher, streamingWsRegistry } = makePublisher(sessionMapper);

    await publisher.publishIfSideTask(30);

    // 唯一信号键 = 根主会话 10，且 treeRunning 由深层边路 30 驱动
    expect(streamingWsRegistry.send).toHaveBeenCalledTimes(1);
    expect(streamingWsRegistry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_tree_status',
      sessionId: 10,
      data: expect.objectContaining({ treeRunning: true, treeUnread: true }),
    }));
  });

  it('publishAtRootStopsSilentlyWhenParentChainIsBroken', async () => {
    const sessionMapper = {
      selectById: vi.fn(async (id: number) => {
        // 父会话 20 已删除（孤儿边路 30）
        if (id === 30) return { id: 30, userId: 7, sessionType: 'SIDE_TASK', parentSessionId: 20, phase: 'RUNNING', unread: 0 };
        return null;
      }),
      listDescendantSideTasks: vi.fn(async () => []),
    };
    const { publisher, streamingWsRegistry } = makePublisher(sessionMapper);

    await publisher.publishIfSideTask(30);

    expect(streamingWsRegistry.send).not.toHaveBeenCalled();
    expect(sessionMapper.listDescendantSideTasks).not.toHaveBeenCalled();
  });

  it('publishForSessionKeysRootSignalForNormalSessionWithoutConvergence', async () => {
    const sessionMapper = {
      selectById: vi.fn(async (id: number) => (
        { id, userId: 7, sessionType: 'NORMAL', parentSessionId: null, phase: 'RUNNING', unread: 0 }
      )),
      listDescendantSideTasks: vi.fn(async () => []),
    };
    const { publisher, streamingWsRegistry } = makePublisher(sessionMapper);

    await publisher.publishForSession(10);

    expect(streamingWsRegistry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_tree_status',
      sessionId: 10,
    }));
  });
});
