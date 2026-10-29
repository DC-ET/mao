/**
 * 逻辑 BUG 审查第二轮（2026-10-29）——background-subagent-tools 数值参数校验。
 *
 * 每个测试断言「正确行为」，当前代码因对应 BUG 而失败——测试失败即证明 BUG 真实存在。
 * 配套文档：docs/code-review/2026-10-29-logic-bug-audit-round2.md
 */
import { describe, expect, it, vi } from 'vitest';
import { CancelSubagentTool, WaitSubagentsTool } from './background-subagent-tools.js';

const DEFAULT_WAIT_MS = 30 * 60 * 1000;

describe('Logic Bug Audit Round2 — background-subagent-tools', () => {
  it('BUG-R2-3: wait_subagents 的 timeout_seconds 传 1e308 不得放大成 Infinity 超时', async () => {
    const manager = {
      waitForAll: vi.fn(async () => ({ completed: false, timedOut: true })),
      consumeResults: vi.fn(async () => ({})),
      progress: vi.fn(async () => []),
    };
    const tool = new WaitSubagentsTool(manager as never);
    await tool.execute(JSON.stringify({ timeout_seconds: 1e308 }), 11, null, null);
    expect(manager.waitForAll).toHaveBeenCalledTimes(1);
    const timeoutMs = manager.waitForAll.mock.calls[0]![2] as number;
    // 正确行为：工具应把毫秒超时钳制在有限范围（1e308 * 1000 已溢出为 Infinity，
    // 必须在入参校验或换算后拦住），否则 BackgroundSubagentManager.waitForAll 的
    // deadline 永不到期，子代理挂起时该工具调用无限阻塞整个 agent 循环。
    // BUG：Number.isFinite(1e308) 通过校验，timeoutSeconds * 1000 = Infinity 原样下发。
    expect(Number.isFinite(timeoutMs)).toBe(true);
  });

  it('BUG-R2-3b: wait_subagents 的 timeout_seconds 传空串应回落默认 30 分钟而非 0ms', async () => {
    const manager = {
      waitForAll: vi.fn(async () => ({ completed: false, timedOut: true })),
      consumeResults: vi.fn(async () => ({})),
      progress: vi.fn(async () => []),
    };
    const tool = new WaitSubagentsTool(manager as never);
    await tool.execute(JSON.stringify({ timeout_seconds: '' }), 11, null, null);
    const timeoutMs = manager.waitForAll.mock.calls[0]![2] as number;
    // 正确行为：与本仓库 asInt 口径一致，'' 不是数字 → 回落默认 1800s
    // BUG：裸 Number('') = 0，0 通过「非负数字」校验 → waitForAll(…, 0) 立即超时返回
    expect(timeoutMs).toBe(DEFAULT_WAIT_MS);
  });

  it('BUG-R2-3c: timeout_seconds 极大值应被钳制到有限上界（影响证明）', async () => {
    const manager = {
      waitForAll: vi.fn(async () => ({ completed: false, timedOut: true })),
      consumeResults: vi.fn(async () => ({})),
      progress: vi.fn(async () => []),
    };
    const tool = new WaitSubagentsTool(manager as never);
    await tool.execute(JSON.stringify({ timeout_seconds: 1e308 }), 11, null, null);
    const timeoutMs = manager.waitForAll.mock.calls[0]![2] as number;
    // 修复前：1e308 * 1000 = Infinity，deadline 永不到期，waitForAll 在有子代理运行时永久空转；
    // 修复后：工具把毫秒超时钳制到 24h 上界——既保留「等很久」的能力，又保证有限等待
    expect(timeoutMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(timeoutMs).toBeGreaterThan(DEFAULT_WAIT_MS);
  });

  it('BUG-R2-4: cancel_subagent 应拒绝空串/布尔/数组形式的 task_id', async () => {
    const manager = { cancel: vi.fn(async () => ({ success: false })) };
    const tool = new CancelSubagentTool(manager as never);
    for (const bad of ['', false, []]) {
      const result = JSON.parse(await tool.execute(JSON.stringify({ task_id: bad }), 11, null, null));
      // 正确行为：报「参数 task_id 必须是整数」并拒绝执行
      // BUG：Number('')=0、Number(false)=0、Number([])=0 都通过 Number.isInteger 校验，
      // 以 taskId=0 继续调用 manager.cancel，最终回传误导性的「后台子代理不存在」
      expect(result.error).toEqual(expect.stringContaining('必须是整数'));
      expect(manager.cancel).not.toHaveBeenCalled();
    }
  });

  it('BUG-R2-4b: cancel_subagent 的 task_id 数组 [5] 不得被 Number() 静默转成 5', async () => {
    const manager = { cancel: vi.fn(async () => ({ success: false })) };
    const tool = new CancelSubagentTool(manager as never);
    const result = JSON.parse(await tool.execute(JSON.stringify({ task_id: [5] }), 11, null, null));
    // 正确行为：单元素数组不是整数入参，必须报错
    // BUG：Number([5]) = 5 通过校验，直接取消了 #5 号子代理
    expect(result.error).toEqual(expect.stringContaining('必须是整数'));
    expect(manager.cancel).not.toHaveBeenCalled();
  });
});
