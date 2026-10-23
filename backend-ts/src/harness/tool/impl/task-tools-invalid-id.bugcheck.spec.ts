import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDeleteTool, TaskUpdateTool } from './task-tools.js';
import type { SessionTodoMapper } from '../../todo/session-todo.mapper.js';
import type { SessionTodo } from '../../todo/entity/session-todo.js';
import { normalizeToolResult } from '../../tool/tool-result.js';

function todo(id: number, content: string, status: string): SessionTodo {
  return { id, sessionId: 11, content, status, sortOrder: id };
}

/**
 * 回归：`id` 校验用的是 `Number(item.id)`，而 `Number(null) === 0`、`Number('') === 0`。
 * 于是 `{"id": null}` / `{"id": ""}` 都能通过 `Number.isFinite` 校验，被当成「待办 #0」：
 *   - task_update：updateFields(0, sessionId, …) 命中 0 行，却照样回报
 *     「已将任务 #0 更新为 completed」，并把 transitionedToCompleted 置真 → 假成功；
 *   - task_delete：delete(0, sessionId) 什么都没删，却回报「已删除 1 个事项」→ 假成功。
 *
 * 模型据此会认为任务已完成/已删除，真实的待办条目仍然留在库里（状态未推进），
 * 任务面板与「全部完成」判定与真实状态脱节。
 */
describe('TaskTools invalid todo id', () => {
  const mapper = {
    resetInProgress: vi.fn(),
    resetInProgressIfExists: vi.fn(async () => false),
    insert: vi.fn(),
    selectBySessionId: vi.fn(async () => [todo(1, 'a', 'pending'), todo(2, 'b', 'pending'), todo(3, 'c', 'pending')]),
    selectMaxSortOrder: vi.fn(async () => -1),
    updateFields: vi.fn(),
    delete: vi.fn(),
  } as unknown as SessionTodoMapper & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mapper.selectBySessionId.mockResolvedValue([todo(1, 'a', 'pending'), todo(2, 'b', 'pending'), todo(3, 'c', 'pending')]);
  });

  it('rejects a null id instead of reporting task #0 as completed', async () => {
    const tool = new TaskUpdateTool(mapper);
    const raw = await tool.execute(JSON.stringify({ items: [{ id: null, status: 'completed' }] }), 11, null);
    const result = JSON.parse(raw);

    // 必须报错，不能假成功
    expect(result.error).toBeTruthy();
    expect(normalizeToolResult('call-1', raw).status).toBe('error');
    // 不得拿 0 去写库
    expect(mapper.updateFields).not.toHaveBeenCalled();
    // 不得声称「已将任务 #0 更新为 completed」
    expect(result.summary ?? '').not.toContain('#0');
  });

  it('rejects an empty-string id instead of reporting task #0 as completed', async () => {
    const tool = new TaskUpdateTool(mapper);
    const raw = await tool.execute(JSON.stringify({ items: [{ id: '', status: 'completed' }] }), 11, null);
    const result = JSON.parse(raw);

    expect(result.error).toBeTruthy();
    expect(mapper.updateFields).not.toHaveBeenCalled();
    expect(result.summary ?? '').not.toContain('#0');
  });

  it('rejects a null id in delete instead of claiming one item was deleted', async () => {
    const tool = new TaskDeleteTool(mapper);
    const raw = await tool.execute(JSON.stringify({ items: [{ id: null }] }), 11, null);
    const result = JSON.parse(raw);

    expect(result.error).toBeTruthy();
    expect(mapper.delete).not.toHaveBeenCalled();
    expect(result.message ?? '').not.toContain('已删除 1 个事项');
  });
});
