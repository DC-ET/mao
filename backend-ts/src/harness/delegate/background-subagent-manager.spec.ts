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
    // 运行中 token 统计读 context.totalUsage（AgentLoop 每轮 addUsage 实时累计）
    const context = {
      currentRound: 4,
      totalUsage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
    } as never;
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

  it('recentOutput picks last assistant message even when it carries tool calls', async () => {
    const execution = {
      id: 7,
      parentSessionId: 1,
      childSessionId: 42,
      agentType: 'reviewer',
      status: 'RUNNING',
      invocationType: 'BACKGROUND',
    };
    const messages = [
      { role: 'USER', content: 'hi' },
      { role: 'ASSISTANT', content: '', toolCalls: '[{"id":"a"}]' },
      { role: 'ASSISTANT', content: '正在读取文件', toolCalls: '[{"id":"b"}]' },
      { role: 'ASSISTANT', content: null, toolCalls: '[{"id":"c"}]' },
    ];
    const manager = buildManager(execution, messages);

    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.recentOutput).toBe('正在读取文件');
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

function buildRetryManager(execution: Record<string, unknown>, opts?: {
  child?: Record<string, unknown>;
  parent?: Record<string, unknown>;
}) {
  const child = opts?.child ?? { id: 42, sessionType: 'SUBAGENT', parentSessionId: 1 };
  const parent = opts?.parent ?? { id: 1, phase: 'RUNNING' };
  const updateById = vi.fn(async (_id: number, data: Record<string, unknown>) => {
    Object.assign(execution, data);
  });
  const updateTerminal = vi.fn(async (_id: number, data: Record<string, unknown>) => {
    if (execution.status !== 'RUNNING' && execution.status !== 'RECOVERING') return false;
    Object.assign(execution, data);
    return true;
  });
  const subagentExecutionMapper = {
    findById: vi.fn(async () => execution),
    findByChildSessionId: vi.fn(async () => execution),
    listByParent: vi.fn(async () => [execution]),
    updateById,
    updateTerminal,
  };
  const sessionMapper = { selectById: vi.fn(async (id: number) => (id === 42 ? child : parent)) };
  const sessionService = {
    getMessages: vi.fn(async () => [
      { role: 'ASSISTANT', content: '子代理重试后的输出' },
    ]),
    saveMessage: vi.fn(async () => ({ id: 901 })),
  };
  const deps = { subagentExecutionMapper, sessionMapper, sessionService } as never;
  return { manager: new BackgroundSubagentManager(deps), mocks: { updateById, updateTerminal } };
}

describe('BackgroundSubagentManager retry bookkeeping', () => {
  it('beginRetry resets the terminal execution to RUNNING and check_subagent sees it', async () => {
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'FAILED', invocationType: 'BACKGROUND', result: '后台子代理执行失败: boom',
      deliveryStatus: 'DELIVERED',
    };
    const { manager } = buildRetryManager(execution);

    const result = await manager.beginRetry(1, 42);

    expect(result).toMatchObject({ ok: true, taskId: 7, childSessionId: 42 });
    expect(execution.status).toBe('RUNNING');
    expect(execution.result).toBeNull();
    expect(execution.completedAt).toBeNull();
    expect(execution.deliveryStatus).toBe('PENDING');
    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.status).toBe('RUNNING');
  });

  it('beginRetry discards stale undelivered failure results for the same task', async () => {
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'FAILED', invocationType: 'BACKGROUND', deliveryStatus: 'DELIVERED',
    };
    const { manager } = buildRetryManager(execution);
    // 模拟主代理尚未消费的旧失败结果
    (manager as unknown as { resultsByParent: Map<number, Array<{ executionId: number; resultJson: string }>> })
      .resultsByParent.set(1, [{ executionId: 7, resultJson: '{"status":"FAILED"}' }]);

    await manager.beginRetry(1, 42);

    const pending = (manager as unknown as { resultsByParent: Map<number, unknown[]> }).resultsByParent.get(1);
    expect(pending ?? []).toHaveLength(0);
  });

  it('beginRetry rejects non-subagent sessions and still-running executions', async () => {
    const running = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'RUNNING', invocationType: 'BACKGROUND',
    };
    const { manager } = buildRetryManager(running);
    expect((await manager.beginRetry(1, 42)).ok).toBe(false);

    const foreignChild = buildRetryManager({ ...running, status: 'FAILED' }, {
      child: { id: 42, sessionType: 'SUBAGENT', parentSessionId: 999 },
    });
    expect((await foreignChild.manager.beginRetry(1, 42)).ok).toBe(false);

    const plainChild = buildRetryManager({ ...running, status: 'FAILED' }, {
      child: { id: 42, sessionType: 'SIDE_TASK', parentSessionId: 1 },
    });
    expect((await plainChild.manager.beginRetry(1, 42)).ok).toBe(false);
  });

  it('completeRetry converges to terminal status and delivers result to an active parent', async () => {
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'FAILED', invocationType: 'BACKGROUND', deliveryStatus: 'DELIVERED',
      taskDescription: '分析问题',
    };
    const { manager } = buildRetryManager(execution, { parent: { id: 1, phase: 'RUNNING' } });
    await manager.beginRetry(1, 42);

    await manager.completeRetry(1, 7, 'COMPLETED');

    expect(execution.status).toBe('COMPLETED');
    expect(execution.result).toBe('子代理重试后的输出');
    expect(execution.deliveryStatus).toBe('DELIVERED');
    const results = await manager.consumeResults(1);
    const payload = JSON.parse(results['7']) as Record<string, unknown>;
    expect(payload).toMatchObject({ success: true, status: 'COMPLETED', task_id: 7, child_session_id: 42 });
  });

  it('completeRetry suppresses delivery when the parent session is terminal', async () => {
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'FAILED', invocationType: 'BACKGROUND', deliveryStatus: 'PENDING',
    };
    const { manager, mocks } = buildRetryManager(execution, { parent: { id: 1, phase: 'COMPLETED' } });
    await manager.beginRetry(1, 42);

    await manager.completeRetry(1, 7, 'COMPLETED');

    expect(execution.status).toBe('COMPLETED');
    expect(execution.deliveryStatus).toBe('SUPPRESSED');
    expect(await manager.consumeResults(1)).toEqual({});
  });

  it('completeRetry keeps db state when a concurrent cancel already converged the execution', async () => {
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'CANCELLED', invocationType: 'BACKGROUND', deliveryStatus: 'SUPPRESSED',
      result: '后台子代理已随父会话取消',
    };
    const { manager, mocks } = buildRetryManager(execution);
    // 模拟 cancelAllForParent 已把记录收敛为 CANCELLED：updateTerminal 条件不满足
    mocks.updateTerminal.mockResolvedValue(false);

    await manager.completeRetry(1, 7, 'COMPLETED');

    expect(execution.status).toBe('CANCELLED');
    expect(execution.result).toBe('后台子代理已随父会话取消');
    expect(await manager.consumeResults(1)).toEqual({});
  });
});
