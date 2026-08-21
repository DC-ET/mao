import { describe, expect, it, vi } from 'vitest';
import { BackgroundSubagentManager, type BackgroundProgress } from './background-subagent-manager.js';
import { SubAgentResultCollector } from './subagent-result-collector.js';

function buildManager(execution: Record<string, unknown>, messages: unknown[] = []) {
  const subagentExecutionMapper = {
    findById: vi.fn(async () => execution),
    listByParent: vi.fn(async () => [execution]),
  };
  const sessionService = {
    getMessages: vi.fn(async () => messages),
  };
  const deps = { subagentExecutionMapper, sessionService } as never;
  return new BackgroundSubagentManager(deps);
}

describe('BackgroundSubagentManager.progress snapshot', () => {
  it('reads live refs from memory while running', async () => {
    const execution = {
      id: 7,
      parentSessionId: 1,
      childSessionId: 42,
      agentType: 'reviewer',
      status: 'RUNNING',
      invocationType: 'BACKGROUND',
      totalRounds: 0,
      totalToolCalls: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    };
    const manager = buildManager(execution);

    const collector = new SubAgentResultCollector();
    collector.toolCallCount = 3;
    collector.totalUsage = { promptTokens: 120, completionTokens: 45, totalTokens: 165 };
    const context = { currentRound: 4 } as never;
    (manager as unknown as { runningRefsByTask: Map<number, unknown> }).runningRefsByTask.set(7, {
      context,
      collector,
    });

    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.status).toBe('RUNNING');
    expect(snap.totalRounds).toBe(4);
    expect(snap.totalToolCalls).toBe(3);
    expect(snap.totalPromptTokens).toBe(120);
    expect(snap.totalCompletionTokens).toBe(45);
  });

  it('falls back to db values when no live refs (not yet tracked)', async () => {
    const execution = {
      id: 7,
      parentSessionId: 1,
      childSessionId: 42,
      agentType: 'reviewer',
      status: 'RUNNING',
      invocationType: 'BACKGROUND',
      totalRounds: 0,
      totalToolCalls: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    };
    const manager = buildManager(execution);

    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.totalRounds).toBe(0);
    expect(snap.totalToolCalls).toBe(0);
  });

  it('reads persisted db values when terminal, ignoring stale refs', async () => {
    const execution = {
      id: 7,
      parentSessionId: 1,
      childSessionId: 42,
      agentType: 'reviewer',
      status: 'COMPLETED',
      invocationType: 'BACKGROUND',
      result: 'done',
      totalRounds: 9,
      totalToolCalls: 12,
      totalPromptTokens: 500,
      totalCompletionTokens: 200,
    };
    const manager = buildManager(execution);

    // 即使内存里残留引用，终态也应以 DB 落库值为准
    const collector = new SubAgentResultCollector();
    collector.toolCallCount = 999;
    (manager as unknown as { runningRefsByTask: Map<number, unknown> }).runningRefsByTask.set(7, {
      context: { currentRound: 999 } as never,
      collector,
    });

    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.status).toBe('COMPLETED');
    expect(snap.totalRounds).toBe(9);
    expect(snap.totalToolCalls).toBe(12);
    expect(snap.totalPromptTokens).toBe(500);
    expect(snap.totalCompletionTokens).toBe(200);
    expect(snap.recentOutput).toBe('done');
  });
});
