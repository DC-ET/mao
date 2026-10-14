import { describe, expect, it, vi } from 'vitest';
import { BackgroundSubagentManager, type BackgroundProgress } from './background-subagent-manager.js';

/**
 * BUG：BackgroundSubagentManager.beginRetry 只重置了 result / completedAt /
 * deliveryStatus / status，没有重置同一 execution 行上的 finalMessageId 与
 * totalRounds / totalToolCalls / totalPromptTokens / totalCompletionTokens。
 * 这些字段与 result 一样都是「一次尝试（attempt）」的语义，重试复用同一行
 * （task_id 不变）时必须一起作废，否则：
 *   1. check_subagent / progress 把上一轮（失败）尝试的轮数、工具调用数、
 *      token 统计当作新一轮重试的实时进度上报；
 *   2. finalMessageId 仍指向上一轮尝试的结论文档：重试执行期间进程崩溃后，
 *      SubagentExecutionRecoveryService.findPersistedFinal 会直接采纳这条
 *      陈旧 finalMessageId，把上一轮的结论当作本轮终态落库并跳过重跑。
 */

function buildRetryManager(execution: Record<string, unknown>, opts?: {
  child?: Record<string, unknown>;
  parent?: Record<string, unknown>;
}) {
  const child = opts?.child ?? { id: 42, sessionType: 'SUBAGENT', parentSessionId: 1 };
  const parent = opts?.parent ?? { id: 1, phase: 'RUNNING' };
  const updateById = vi.fn(async (_id: number, data: Record<string, unknown>) => {
    Object.assign(execution, data);
  });
  const subagentExecutionMapper = {
    findById: vi.fn(async () => execution),
    findByChildSessionId: vi.fn(async () => execution),
    listByParent: vi.fn(async () => [execution]),
    updateById,
    updateTerminal: vi.fn(async () => true),
  };
  const sessionMapper = { selectById: vi.fn(async (id: number) => (id === 42 ? child : parent)) };
  const sessionService = {
    getMessages: vi.fn(async () => []),
    saveMessage: vi.fn(async () => ({ id: 901 })),
  };
  const deps = { subagentExecutionMapper, sessionMapper, sessionService } as never;
  return { manager: new BackgroundSubagentManager(deps), updateById };
}

/** 一轮已失败的后台执行：finalMessageId 与统计计数均为上一轮尝试的落库值。 */
function failedExecutionWithStats() {
  return {
    id: 7,
    parentSessionId: 1,
    childSessionId: 42,
    agentType: 'reviewer',
    status: 'FAILED',
    invocationType: 'BACKGROUND',
    result: '后台子代理执行失败: boom',
    deliveryStatus: 'DELIVERED',
    completedAt: '2026-10-14 10:00:00',
    finalMessageId: 500,
    totalRounds: 3,
    totalToolCalls: 5,
    totalPromptTokens: 1200,
    totalCompletionTokens: 300,
  };
}

describe('beginRetry per-attempt state reset (bugcheck)', () => {
  it('clears the previous attempt finalMessageId so recovery cannot adopt a stale conclusion', async () => {
    const execution = failedExecutionWithStats();
    const { manager } = buildRetryManager(execution);

    const result = await manager.beginRetry(1, 42);

    expect(result).toMatchObject({ ok: true, taskId: 7 });
    // 新一轮重试开始后，上一轮尝试的结论文档 id 必须作废；
    // 否则重试期间崩溃，恢复链路会把 message 500（上一轮结论）当作本轮终态。
    expect(execution.finalMessageId).toBeNull();
  });

  it('resets the per-attempt counters so check_subagent does not report the previous attempt stats', async () => {
    const execution = failedExecutionWithStats();
    const { manager } = buildRetryManager(execution);

    await manager.beginRetry(1, 42);

    // 与 result / completedAt 同口径：统计字段也是一次尝试的语义，必须归零，
    // 不能把上一轮失败尝试的 3 轮 / 5 次工具调用 / 1500 token 当作新重试的进度。
    expect(execution.totalRounds).toBe(0);
    expect(execution.totalToolCalls).toBe(0);
    expect(execution.totalPromptTokens).toBe(0);
    expect(execution.totalCompletionTokens).toBe(0);

    const snap = (await manager.progress(1, 7)) as BackgroundProgress;
    expect(snap.status).toBe('RUNNING');
    expect(snap.totalRounds).toBe(0);
    expect(snap.totalToolCalls).toBe(0);
    expect(snap.totalPromptTokens).toBe(0);
    expect(snap.totalCompletionTokens).toBe(0);
  });
});
