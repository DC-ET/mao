import { describe, expect, it, vi } from 'vitest';
import { SubagentExecutionRecoveryService } from './subagent-execution-recovery.service.js';

function harness(claimed: boolean) {
  const executionMapper = {
    claimRecovering: vi.fn(async () => claimed),
    updateTerminal: vi.fn(async () => undefined),
  };
  const sessionMapper = {
    selectById: vi.fn(async (id: number) => ({ id, phase: id === 1 ? 'RUNNING' : 'RESUMING', userId: 7, executionMode: 'CLOUD' })),
  };
  const sessionService = {
    updatePhase: vi.fn(async () => undefined),
    getMessagesAfterId: vi.fn(async () => []),
    saveMessage: vi.fn(async () => undefined),
    cleanupIncompleteTailAfterId: vi.fn(async () => undefined),
  };
  const compactionService = { loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) };
  const definitionRegistry = { getDefinition: vi.fn(() => ({ name: 'coder' })) };
  const buildSubContext = vi.fn(async () => ({ currentRound: 0 }));
  const agentLoop = { registerCancelFlag: vi.fn(() => ({ get: () => false })), removeCancelFlag: vi.fn() };
  const visibilityService = { executeVisible: vi.fn(), finishSubagent: vi.fn(async () => undefined) };
  const localRegistry = { isConnected: vi.fn(async () => true), setUserForSession: vi.fn(), removeSession: vi.fn() };
  const service = new SubagentExecutionRecoveryService(
    executionMapper as never, sessionMapper as never, sessionService as never,
    compactionService as never, definitionRegistry as never, buildSubContext as never,
    agentLoop as never, visibilityService as never, localRegistry as never,
  );
  return { service, executionMapper, sessionService, buildSubContext, visibilityService };
}

const execution = {
  id: 55, parentSessionId: 1, childSessionId: 2, status: 'RUNNING',
  agentType: 'coder', startedAt: '2026-08-15 10:00:00',
};

describe('SubagentExecutionRecoveryService', () => {
  it('stops when another instance already claimed the execution', async () => {
    const { service, executionMapper, buildSubContext, sessionService } = harness(false);
    await service.recover(execution as never);
    expect(executionMapper.claimRecovering).toHaveBeenCalledWith(55);
    expect(buildSubContext).not.toHaveBeenCalled();
    expect(sessionService.updatePhase).not.toHaveBeenCalled();
  });

  it('proceeds past the claim when it wins', async () => {
    const { service, buildSubContext } = harness(true);
    await service.recover(execution as never);
    expect(buildSubContext).toHaveBeenCalled();
  });

  it('fails a LOCAL child when the desktop does not connect within the wait', async () => {
    const executionMapper = {
      claimRecovering: vi.fn(async () => true),
      updateTerminal: vi.fn(async () => undefined),
    };
    const sessionMapper = {
      selectById: vi.fn(async (id: number) => ({
        id, phase: 'RUNNING', userId: 7, executionMode: id === 2 ? 'LOCAL' : 'CLOUD',
      })),
    };
    const sessionService = {
      updatePhase: vi.fn(async () => undefined),
      getMessagesAfterId: vi.fn(async () => []),
      saveMessage: vi.fn(async () => undefined),
      cleanupIncompleteTailAfterId: vi.fn(async () => undefined),
    };
    const visibilityService = { executeVisible: vi.fn(), finishSubagent: vi.fn(async () => undefined) };
    const service = new SubagentExecutionRecoveryService(
      executionMapper as never, sessionMapper as never, sessionService as never,
      { loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) } as never,
      { getDefinition: vi.fn(() => ({ name: 'coder' })) } as never,
      vi.fn(async () => ({ currentRound: 0 })) as never,
      { registerCancelFlag: vi.fn(() => ({ get: () => false })), removeCancelFlag: vi.fn() } as never,
      visibilityService as never,
      { isConnected: vi.fn(async () => false), setUserForSession: vi.fn(), removeSession: vi.fn() } as never,
      0,
    );
    await service.recover(execution as never);
    expect(visibilityService.executeVisible).not.toHaveBeenCalled();
    expect(executionMapper.updateTerminal).toHaveBeenCalledWith(55, expect.objectContaining({
      status: 'FAILED',
      result: '子代理恢复失败：LOCAL 客户端未在恢复等待期内连接',
    }));
  });

  it('cancels the child session when the parent is already terminal', async () => {
    const executionMapper = {
      claimRecovering: vi.fn(async () => true),
      updateTerminal: vi.fn(async () => true),
    };
    const sessionMapper = {
      selectById: vi.fn(async (id: number) => ({
        id, phase: id === 1 ? 'CANCELLED' : 'RUNNING', userId: 7,
      })),
    };
    const sessionService = { updatePhase: vi.fn(async () => undefined) };
    const service = new SubagentExecutionRecoveryService(
      executionMapper as never, sessionMapper as never, sessionService as never,
      { loadValidated: vi.fn(), boundaryOf: vi.fn(() => 0) } as never,
      { getDefinition: vi.fn() } as never,
      vi.fn() as never,
      { registerCancelFlag: vi.fn(), removeCancelFlag: vi.fn() } as never,
      { executeVisible: vi.fn(), finishSubagent: vi.fn() } as never,
      { isConnected: vi.fn(), removeSession: vi.fn() } as never,
    );
    await service.recover(execution as never);
    expect(executionMapper.claimRecovering).not.toHaveBeenCalled();
    expect(executionMapper.updateTerminal).toHaveBeenCalledWith(55, expect.objectContaining({ status: 'CANCELLED' }));
    expect(sessionService.updatePhase).toHaveBeenCalledWith(2, 'CANCELLED');
  });
});
