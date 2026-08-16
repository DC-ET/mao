import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCreateTool, TaskDeleteTool, TaskListTool, TaskUpdateTool } from './task-tools.js';
import type { SessionTodoMapper } from '../../todo/session-todo.mapper.js';
import type { SessionTodo } from '../../todo/entity/session-todo.js';

function todo(id: number, content: string, status: string): SessionTodo {
  return { id, sessionId: 11, content, status, sortOrder: id };
}

describe('TaskTools', () => {
  const mapper = {
    resetInProgress: vi.fn(),
    insert: vi.fn(),
    selectBySessionId: vi.fn(),
    updateFields: vi.fn(),
    delete: vi.fn(),
  } as unknown as SessionTodoMapper & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createToolCreatesTodosAndLoadsPrompt', async () => {
    mapper.selectBySessionId.mockResolvedValue([todo(1, 'created', 'pending')]);
    const tool = new TaskCreateTool(mapper);
    expect(tool.getName()).toBe('task_create');
    expect(tool.getDescription()).toContain('创建');
    expect(tool.getInputSchema()).toHaveProperty('required');
    expect(tool.getOutputSchema()).toMatchObject({ type: 'object' });

    const result = JSON.parse(await tool.execute(JSON.stringify({
      items: [
        { content: 'one', description: 'desc', active_form: 'doing', status: 'in_progress' },
        { content: 'two' },
      ],
    }), 11, null));
    expect(result.message).toContain('2');
    expect(mapper.resetInProgress).toHaveBeenCalledWith(11);
    expect(mapper.insert).toHaveBeenCalledTimes(2);
  });

  it('updateToolUpdatesTodosAndEmitsCompletionHints', async () => {
    mapper.selectBySessionId.mockResolvedValue([
      todo(1, 'implement', 'completed'),
      todo(2, 'review', 'completed'),
      todo(3, 'ship', 'completed'),
    ]);
    const tool = new TaskUpdateTool(mapper);
    expect(tool.getName()).toBe('task_update');
    const result = JSON.parse(await tool.execute(JSON.stringify({
      items: [{ id: 1, status: 'in_progress', content: 'implement' }, { id: 1, status: 'completed' }],
    }), 11, null));
    expect(result.summary).toContain('completed');
    expect(result.hint).toContain('验证');
    expect(mapper.updateFields).toHaveBeenCalled();

    mapper.selectBySessionId.mockResolvedValue([todo(1, 'test', 'completed')]);
    const verified = JSON.parse(await tool.execute(JSON.stringify({
      items: [{ id: 1, status: 'completed' }],
    }), 11, null));
    expect(verified.hint).toContain('下一个');
    expect(verified.hint).not.toContain('没有验证');
  });

  it('deleteAndListToolsReturnProgressAndErrors', async () => {
    mapper.selectBySessionId.mockResolvedValue([
      todo(1, 'done', 'completed'),
      todo(2, 'doing', 'in_progress'),
      todo(3, 'todo', 'pending'),
    ]);
    const deleteTool = new TaskDeleteTool(mapper);
    expect(deleteTool.getName()).toBe('task_delete');
    const deleted = JSON.parse(await deleteTool.execute(JSON.stringify({
      items: [{ id: 2 }, { id: 3 }],
    }), 11, null));
    expect(deleted.message).toContain('2');
    expect(mapper.delete).toHaveBeenCalledTimes(2);

    const listTool = new TaskListTool(mapper);
    expect(listTool.getName()).toBe('task_list');
    const listed = JSON.parse(await listTool.execute('{}', 11, null));
    expect(listed.progress).toContain('1/3');
    expect(listed.progress).toContain('进行中 1');
    expect(listed.hint).toContain('in_progress');
    expect(JSON.parse(await deleteTool.execute('not-json', 11, null)).error).toBeTruthy();
    expect(JSON.parse(await listTool.execute('{}', 11, null))).toHaveProperty('todos');
  });
});
