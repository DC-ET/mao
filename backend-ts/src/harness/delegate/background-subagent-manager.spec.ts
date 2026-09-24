import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionContext } from '../core/agent-execution-context.js';
import type { Tool } from '../tool/tool.js';
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
  assistantContent?: string;
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
  const findById = vi.fn(async () => execution);
  const subagentExecutionMapper = {
    findById,
    findByChildSessionId: vi.fn(async () => execution),
    listByParent: vi.fn(async () => [execution]),
    updateById,
    updateTerminal,
  };
  const sessionMapper = { selectById: vi.fn(async (id: number) => (id === 42 ? child : parent)) };
  const sessionService = {
    getMessages: vi.fn(async () => [
      { role: 'ASSISTANT', content: opts?.assistantContent ?? '子代理重试后的输出' },
    ]),
    saveMessage: vi.fn(async () => ({ id: 901 })),
  };
  const deps = { subagentExecutionMapper, sessionMapper, sessionService } as never;
  return { manager: new BackgroundSubagentManager(deps), mocks: { updateById, updateTerminal, findById } };
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

  it('completeRetry keeps running track until the result is queued', async () => {
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'FAILED', invocationType: 'BACKGROUND', deliveryStatus: 'DELIVERED',
    };
    const { manager, mocks } = buildRetryManager(execution, { parent: { id: 1, phase: 'RUNNING' } });
    await manager.beginRetry(1, 42);
    expect(manager.hasRunning(1)).toBe(true);

    let releaseFind!: (value: unknown) => void;
    mocks.findById.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFind = resolve;
    }));

    const completing = manager.completeRetry(1, 7, 'COMPLETED');
    await Promise.resolve();
    expect(manager.hasRunning(1)).toBe(true);
    expect(manager.hasPendingResults(1)).toBe(false);
    expect(await manager.waitForAll(1, null, 20)).toEqual({ completed: false, timedOut: true });

    releaseFind(execution);
    await completing;
    expect(manager.hasRunning(1)).toBe(false);
    expect(manager.hasPendingResults(1)).toBe(true);
    const payload = JSON.parse((await manager.consumeResults(1))['7']) as Record<string, unknown>;
    expect(payload.result).toBe('子代理重试后的输出');
  });

  it('completeRetry delivers the full assistant output instead of the 2000-char preview', async () => {
    const conclusion = '【结论】关键修复已完成';
    const full = `${'前部预览'.repeat(600)}${conclusion}`;
    expect(full.length).toBeGreaterThan(2000);
    const execution = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'FAILED', invocationType: 'BACKGROUND', deliveryStatus: 'DELIVERED',
    };
    const { manager } = buildRetryManager(execution, {
      parent: { id: 1, phase: 'RUNNING' },
      assistantContent: full,
    });
    await manager.beginRetry(1, 42);
    await manager.completeRetry(1, 7, 'COMPLETED');

    expect(execution.result).toBe(full);
    const payload = JSON.parse((await manager.consumeResults(1))['7']) as Record<string, unknown>;
    expect(payload.result).toBe(full);
    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.recentOutput).toBe(`${full.slice(0, 2000)}...`);
    expect(snap.recentOutput).not.toContain(conclusion);
  });
});

describe('BackgroundSubagentManager terminal write', () => {
  it('does not overwrite a cancel that landed while the child was finishing', async () => {
    const execution: Record<string, unknown> = {
      id: 7, parentSessionId: 1, childSessionId: 42, agentType: 'reviewer',
      status: 'RUNNING', invocationType: 'BACKGROUND', deliveryStatus: 'PENDING',
    };
    const updateTerminal = vi.fn(async (_id: number, data: Record<string, unknown>) => {
      if (execution.status !== 'RUNNING' && execution.status !== 'RECOVERING') return false;
      Object.assign(execution, data);
      return true;
    });
    const finishSubagent = vi.fn(async () => undefined);
    const manager = new BackgroundSubagentManager({
      harnessService: () => ({
        buildContext: async () => ({
          tools: [] as Array<{ getName(): string }>,
          availableSkillDocs: new Map<string, string>(),
          currentRound: 1,
        }),
      }),
      subagentExecutionMapper: {
        findById: vi.fn(async () => execution),
        updateTerminal,
        updateById: vi.fn(async (_id: number, data: Record<string, unknown>) => { Object.assign(execution, data); }),
      },
      sessionMapper: { selectById: vi.fn(async () => ({ id: 1, phase: 'RUNNING', userId: 7 })) },
      sessionService: { saveMessage: vi.fn(async () => ({ id: 1 })), getMessages: vi.fn(async () => []) },
      agentLoop: () => ({
        getCancelFlag: () => undefined,
        registerCancelFlag: () => ({ get: () => false, set: () => undefined }),
        removeCancelFlag: () => undefined,
      }),
      visibilityService: {
        executeVisible: vi.fn(async () => {
          execution.status = 'CANCELLED';
          execution.deliveryStatus = 'SUPPRESSED';
          execution.result = '后台子代理已随父会话取消';
          return { collector: new SubAgentResultCollector(), executionId: 'e1' };
        }),
        finishSubagent,
      },
      localToolSessionRegistry: { removeSession: vi.fn() },
    } as never);

    await (manager as unknown as {
      runBackground: (execution: unknown, child: unknown, definition: unknown) => Promise<void>;
    }).runBackground(execution, { id: 42, userId: 7 }, { name: 'reviewer' });

    expect(updateTerminal).toHaveBeenCalled();
    expect(execution.status).toBe('CANCELLED');
    expect(execution.result).toBe('后台子代理已随父会话取消');
    expect(finishSubagent).not.toHaveBeenCalled();
  });
});

describe('BackgroundSubagentManager.buildSubContext', () => {
  it('removes ask_user_questions from every subagent', async () => {
    const ctx = new AgentExecutionContext();
    ctx.tools = [
      { getName: () => 'read_file' } as Tool,
      { getName: () => 'ask_user_questions' } as Tool,
      { getName: () => 'dingtalk_send_image' } as Tool,
      { getName: () => 'dingtalk_send_file' } as Tool,
      { getName: () => 'spawn_subagent' } as Tool,
    ];
    const manager = new BackgroundSubagentManager({
      harnessService: () => ({ buildContext: async () => ctx }),
    } as never);
    const subCtx = await manager.buildSubContext({ id: 42 } as never, { name: 'default' });
    const names = subCtx.tools.map((tool) => tool.getName());
    expect(names).toEqual(['read_file']);
  });
});
