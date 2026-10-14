import { describe, expect, it, vi } from 'vitest';
import { SubagentExecutionRecoveryService } from './subagent-execution-recovery.service.js';

/**
 * BUG 的端到端后果（根因在 background-subagent-manager.ts 的 beginRetry）：
 * 用户重试一个终态后台子代理时，beginRetry 把 execution 置回 RUNNING、清空
 * result，但没有清空 finalMessageId。于是库里出现自相矛盾的状态：
 *   result = null（本轮还没有结论） 但 finalMessageId = 500（指向上一轮尝试的结论）
 * 此时重试执行尚未跑完进程就崩溃，恢复链路 listRecoveryCandidates 会捞出这条
 * PENDING + RUNNING 的记录，findPersistedFinal 见到 finalMessageId 仍指向一条
 * 存在的 ASSISTANT 消息，便直接把上一轮尝试的结论当作本轮终态落库，
 * 完全不重跑（executeVisible 一次都不调用）。
 *
 * 正确行为：finalMessageId 属于「一次尝试」，beginRetry 开新一轮时必须作废；
 * 作废后恢复链路找不到已持久化终态，应重新执行该子代理。
 */

function harness(messages: Array<Record<string, unknown>>) {
  const executionMapper = {
    claimRecovering: vi.fn(async () => true),
    updateTerminal: vi.fn(async () => true),
  };
  const sessionMapper = {
    selectById: vi.fn(async (id: number) => ({ id, phase: 'RUNNING', userId: 7, executionMode: 'CLOUD' })),
  };
  const sessionService = {
    updatePhase: vi.fn(async () => undefined),
    getMessagesAfterId: vi.fn(async () => messages),
    saveMessage: vi.fn(async () => ({ id: 902 })),
    cleanupIncompleteTailAfterId: vi.fn(async () => undefined),
  };
  const visibilityService = {
    executeVisible: vi.fn(async () => ({
      collector: {
        error: undefined,
        getResult: () => '重试后的新结论',
        getThinkingContent: () => null,
        toolCallCount: 2,
        totalUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      executionId: 'run-1',
    })),
    finishSubagent: vi.fn(async () => undefined),
  };
  const service = new SubagentExecutionRecoveryService(
    executionMapper as never,
    sessionMapper as never,
    sessionService as never,
    { loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) } as never,
    { getDefinition: vi.fn(() => ({ name: 'coder' })) } as never,
    vi.fn(async () => ({ currentRound: 0 })) as never,
    { registerCancelFlag: vi.fn(() => ({ get: () => false })), removeCancelFlag: vi.fn() } as never,
    visibilityService as never,
    { isConnected: vi.fn(async () => true), setUserForSession: vi.fn(), removeSession: vi.fn() } as never,
  );
  return { service, executionMapper, visibilityService };
}

describe('SubagentExecutionRecoveryService after a retry began (bugcheck)', () => {
  it('re-runs the subagent instead of adopting the previous attempt final message', async () => {
    // beginRetry 之后的真实库态：result 已清空、状态回到 RUNNING，
    // 但 finalMessageId 仍残留上一轮尝试的结论文档 500。
    const execution = {
      id: 55,
      parentSessionId: 1,
      childSessionId: 2,
      status: 'RUNNING',
      invocationType: 'BACKGROUND',
      deliveryStatus: 'PENDING',
      agentType: 'coder',
      result: null,
      completedAt: null,
      finalMessageId: 500,
      executionStartMessageId: 400,
      startedAt: '2026-10-14 10:00:00',
    };
    const { service, executionMapper, visibilityService } = harness([
      { id: 500, role: 'ASSISTANT', content: '上一轮尝试的结论', toolCalls: null },
    ]);

    await service.recover(execution as never);

    // 正确行为：本轮重试没有产生过终态，必须重新执行子代理。
    expect(visibilityService.executeVisible).toHaveBeenCalledTimes(1);
    // 不能把上一轮尝试的结论当作本轮终态落库。
    expect(executionMapper.updateTerminal).not.toHaveBeenCalledWith(
      55,
      expect.objectContaining({ result: '上一轮尝试的结论' }),
    );
  });
});
