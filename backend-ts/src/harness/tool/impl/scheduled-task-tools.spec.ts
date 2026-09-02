import { describe, expect, it, vi } from 'vitest';
import {
  CreateScheduledTaskTool, DeleteScheduledTaskTool, ListScheduledTasksTool, UpdateScheduledTaskTool,
} from './scheduled-task-tools.js';

describe('ScheduledTaskTools', () => {
  const scheduled = {
    createTask: vi.fn(async () => ({ id: 3, name: 'n', cronExpression: '0 0 9 * * *', nextFireTime: 't', sessionId: 11 })),
    listByUser: vi.fn(async () => [{ id: 3, name: 'n' }]),
    updateTask: vi.fn(async () => ({ id: 3, name: 'n2' })),
    deleteTask: vi.fn(),
  };
  const sessions = { getSession: vi.fn(async () => ({ id: 11, agentId: 5, userId: 7 })) };

  it('creates lists updates and deletes', async () => {
    const create = new CreateScheduledTaskTool(scheduled as never, sessions as never);
    expect(create.getName()).toBe('create_scheduled_task');
    expect(create.getToolPrompt()).toContain('cron');
    expect(create.getToolPrompt()).toContain('任务本体');
    expect(create.getToolPrompt()).toContain('严禁在 prompt 中要求创建、修改或删除定时任务');
    expect(create.getDescription()).toContain('创建时的会话');
    expect(create.getInputSchema().properties.prompt.description).toContain('不要包含执行频率');
    const created = JSON.parse(await create.execute(JSON.stringify({
      name: 'n', prompt: 'p', cron_expression: '0 0 9 * * *',
    }), 11, 7, null));
    expect(created.success).toBe(true);
    sessions.getSession.mockResolvedValueOnce(null);
    expect(JSON.parse(await create.execute(JSON.stringify({
      name: 'n', prompt: 'p', cron_expression: '0 0 9 * * *',
    }), 11, 7, null)).error).toContain('Agent');

    const list = new ListScheduledTasksTool(scheduled as never);
    expect(list.getName()).toBe('list_scheduled_tasks');
    expect(JSON.parse(await list.execute('{}', 11, 7, null)).total).toBe(1);
    expect(JSON.parse(await list.execute('{}', null, null, null)).error).toContain('用户');

    const update = new UpdateScheduledTaskTool(scheduled as never);
    expect(update.getName()).toBe('update_scheduled_task');
    expect(JSON.parse(await update.execute(JSON.stringify({ task_id: 3, name: 'n2' }), 11, 7, null)).success).toBe(true);
    expect(JSON.parse(await update.execute('{}', 11, 7, null)).error).toContain('task_id');

    const del = new DeleteScheduledTaskTool(scheduled as never);
    expect(del.getName()).toBe('delete_scheduled_task');
    expect(JSON.parse(await del.execute(JSON.stringify({ task_id: 3 }), 11, 7, null)).success).toBe(true);
    expect(JSON.parse(await del.execute(JSON.stringify({ task_id: 3 }), 11, null, null)).error).toContain('用户');
  });
});
