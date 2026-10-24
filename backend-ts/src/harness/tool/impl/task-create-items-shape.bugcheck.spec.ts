import { describe, expect, it, vi } from 'vitest';
import { TaskCreateTool } from './task-tools.js';

/**
 * task_create 的 items 必须是数组。
 *
 * 模型参数抖动（把数组 JSON.stringify 成字符串）时，当前实现 `Array.isArray ? : []`
 * 静默当成空数组，返回 success：「已创建 0 个事项」+「任务已创建，请将第一个 pending
 * 任务标记为 in_progress」。normalizeToolResult 看不到 error 键 → 判成功；模型据此
 * 以为待办已建立，实际 task_list 为空。
 *
 * 同仓库口径：ask_user_questions 对 questions 的双重编码专门做解壳，解壳后仍为空则
 * 明确报错（tool-dispatcher.ts:415-417），不是返回成功。
 */
function fakeMapper() {
  return {
    selectMaxSortOrder: vi.fn(async () => -1),
    selectBySessionId: vi.fn(async () => [] as unknown[]),
    insert: vi.fn(async () => 1),
    resetInProgress: vi.fn(async () => undefined),
    resetInProgressIfExists: vi.fn(async () => false),
    updateFields: vi.fn(async () => undefined),
  };
}

describe('task_create 参数不是数组时必须报错', () => {
  it('items 被双重编码成 JSON 字符串（当前假成功「已创建 0 个」）', async () => {
    const mapper = fakeMapper();
    const tool = new TaskCreateTool(mapper as never);
    const out = JSON.parse(await tool.execute(JSON.stringify({ items: '[{"content":"a"}]' }), 1));

    expect(out.error).toBeDefined();
    expect(mapper.insert).not.toHaveBeenCalled();
  });

  it('items 是单个对象（当前假成功「已创建 0 个」）', async () => {
    const mapper = fakeMapper();
    const tool = new TaskCreateTool(mapper as never);
    const out = JSON.parse(await tool.execute(JSON.stringify({ items: { content: 'a' } }), 1));

    expect(out.error).toBeDefined();
    expect(mapper.insert).not.toHaveBeenCalled();
  });

  it('对照：合法数组正常创建 1 条', async () => {
    const mapper = fakeMapper();
    const tool = new TaskCreateTool(mapper as never);
    const out = JSON.parse(await tool.execute(JSON.stringify({ items: [{ content: 'a' }] }), 1));

    expect(out.error).toBeUndefined();
    expect(out.message).toContain('1');
    expect(mapper.insert).toHaveBeenCalledTimes(1);
  });
});
