import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import type { SessionTodoMapper } from '../../todo/session-todo.mapper.js';
import type { SessionTodo } from '../../todo/entity/session-todo.js';
import { harnessLog } from '../../log.js';

export class TaskCreateTool extends BaseTool {
  constructor(private readonly sessionTodoMapper: SessionTodoMapper) {
    super();
  }

  getName(): string { return 'task_create'; }
  getDescription(): string {
    return `创建待办事项，用于拆解多步骤工作并跟踪进展。

何时使用：
- 复杂的多步骤任务（3 个或更多明确步骤）
- 收到新的复杂指令后，立即将需求记录为任务
- 规划功能时，将其拆解为具体、可执行的事项

何时不要使用：
- 单个、直接明了的任务
- 跟踪不会带来价值的琐碎任务

内容格式：使用祈使式标题（例如“修复认证问题”），不要使用描述性名词短语（例如“认证问题修复”）。
任务描述应足够具体，使另一个 Agent 也能据此执行。

每个事项可包含：content（必填）、description（可选详情）、active_form（进行中的表述，例如“正在修复认证问题”）。`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要创建的待办事项',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '祈使式任务标题' },
              description: { type: 'string', description: '任务的详细描述' },
              active_form: { type: 'string', description: '任务进行中的表述，例如“正在修复认证问题”' },
              status: { type: 'string', enum: ['pending', 'in_progress'], description: '初始状态（默认：pending）。同一时间只能有一个任务处于 in_progress。' },
            },
            required: ['content'],
          },
        },
      },
      required: ['items'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null, _workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return errorJson('无效的JSON参数');
      const items = Array.isArray(args.items) ? args.items : [];
      let count = 0;
      for (const item of items as Record<string, unknown>[]) {
        const status = asText(item.status) ?? 'pending';
        if (status === 'in_progress' && sessionId != null) {
          await this.sessionTodoMapper.resetInProgress(sessionId);
        }
        const todo: SessionTodo = {
          sessionId: sessionId!,
          content: asText(item.content) ?? '',
          description: asText(item.description) ?? '',
          activeForm: asText(item.active_form) ?? '',
          status,
          sortOrder: count,
        };
        await this.sessionTodoMapper.insert(todo);
        count++;
      }
      const todos = sessionId != null ? await this.sessionTodoMapper.selectBySessionId(sessionId) : [];
      return toJson({
        todos,
        message: `已创建 ${count} 个事项`,
        hint: '任务已创建。请将第一个 pending 任务标记为 in_progress 后开始执行。',
      });
    } catch (e) {
      harnessLog('error', 'TaskCreateTool execution failed', e);
      return errorJson((e as Error).message);
    }
  }
}

export class TaskListTool extends BaseTool {
  constructor(private readonly sessionTodoMapper: SessionTodoMapper) {
    super();
  }
  getName(): string { return 'task_list'; }
  getDescription(): string {
    return `列出当前会话的所有待办事项并查看进展。

何时使用：
- 完成一个任务后，用于查找下一个可执行任务
- 开始工作时，用于查看当前任务计划
- 不确定下一步时，用于检查剩余任务

返回所有任务及其状态（pending/in_progress/completed）和进度摘要。`;
  }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(_argumentsJson: string, sessionId: number | null): Promise<string> {
    try {
      const todos = sessionId != null ? await this.sessionTodoMapper.selectBySessionId(sessionId) : [];
      const completedCount = todos.filter((t) => t.status === 'completed').length;
      const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
      const result: Record<string, unknown> = {
        todos,
        progress: `已完成 ${completedCount}/${todos.length}，进行中 ${inProgressCount}`,
      };
      if (inProgressCount > 0) {
        result.hint = '当前已有任务处于 in_progress。请先继续处理它，再开始其他任务。';
      }
      return toJson(result);
    } catch (e) {
      harnessLog('error', 'TaskListTool execution failed', e);
      return errorJson((e as Error).message);
    }
  }
}

export class TaskUpdateTool extends BaseTool {
  constructor(private readonly sessionTodoMapper: SessionTodoMapper) {
    super();
  }
  getName(): string { return 'task_update'; }
  getDescription(): string {
    return `更新已有待办事项的状态或内容。

状态流转：
- pending → in_progress：开始处理一个任务。同一时间只能有一个任务处于 in_progress。
  将某个任务设为 in_progress 时，会自动把其他 in_progress 任务重置为 pending。
- in_progress → completed：将任务标记为完成。请在完成后立即标记。
  不要批量完成多个任务；每完成一个就立即标记一个。

重要：始终在每个任务完成后立即逐个标记为 completed。
完成一个任务后，使用 task_list 查找下一个可执行任务。

每个事项必须包含：id（必填）。可选字段：status、content、description、active_form。`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要更新的待办事项',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer', description: '待办事项 ID' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              content: { type: 'string', description: '更新后的任务标题' },
              description: { type: 'string', description: '更新后的任务描述' },
              active_form: { type: 'string', description: '更新后的进行中表述' },
            },
            required: ['id'],
          },
        },
      },
      required: ['items'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return errorJson('无效的JSON参数');
      const items = Array.isArray(args.items) ? args.items as Record<string, unknown>[] : [];
      let transitionedToCompleted = false;
      const updatedSummaries: string[] = [];
      for (const item of items) {
        const id = Number(item.id);
        if (!Number.isFinite(id)) {
          return errorJson(`无效的待办事项 ID: ${item.id}`);
        }
        const newStatus = asText(item.status);
        if (newStatus != null && newStatus !== '' && !['pending', 'in_progress', 'completed'].includes(newStatus)) {
          return errorJson(`无效的任务状态: ${newStatus}（只能是 pending / in_progress / completed）`);
        }
        if (newStatus === 'in_progress' && sessionId != null) {
          // M-9：仅当目标存在时才降级其它 in_progress——不存在的 id 不得清掉真实运行中标记
          await this.sessionTodoMapper.resetInProgressIfExists(sessionId, id);
        }
        const fields: Record<string, unknown> = {};
        if (newStatus != null) fields.status = newStatus;
        if (item.content != null) fields.content = asText(item.content);
        if (item.description != null) fields.description = asText(item.description);
        if (item.active_form != null) fields.activeForm = asText(item.active_form);
        if (sessionId != null) await this.sessionTodoMapper.updateFields(id, sessionId, fields);
        if (newStatus === 'completed') {
          transitionedToCompleted = true;
          updatedSummaries.push(`已将任务 #${id} 更新为 completed`);
        } else if (newStatus != null) {
          updatedSummaries.push(`已将任务 #${id} 更新为 ${newStatus}`);
        }
      }
      const todos = sessionId != null ? await this.sessionTodoMapper.selectBySessionId(sessionId) : [];
      const result: Record<string, unknown> = { todos };
      if (updatedSummaries.length > 0) result.summary = updatedSummaries.join('. ');
      if (transitionedToCompleted) {
        const allDone = todos.every((t) => t.status === 'completed');
        if (allDone && todos.length >= 3) {
          const hasVerification = todos.some((t) => {
            const c = (t.content ?? '').toLowerCase();
            return c.includes('verif') || c.includes('验证') || c.includes('测试') || c.includes('test');
          });
          result.hint = hasVerification
            ? '所有任务都已完成。请检查待办列表并撰写最终总结。'
            : '所有任务都已完成，但其中没有验证步骤。\n在撰写最终总结前，请先验证工作结果：\n- 运行相关测试\n- 检查实现是否符合需求\n- 如有需要，创建一个验证任务\n';
        } else {
          result.hint = '任务已完成。请立即调用 task_list 查找下一个可执行任务。';
        }
      }
      return toJson(result);
    } catch (e) {
      harnessLog('error', 'TaskUpdateTool execution failed', e);
      return errorJson((e as Error).message);
    }
  }
}

export class TaskDeleteTool extends BaseTool {
  constructor(private readonly sessionTodoMapper: SessionTodoMapper) {
    super();
  }
  getName(): string { return 'task_delete'; }
  getDescription(): string {
    return `删除不再相关的待办事项。

何时使用：
- 某个任务不再相关，或已被其他任务取代
- 用户明确取消任务或变更需求
- 误创建了重复任务

何时不要使用：
- 不要删除已完成任务（应标记为 completed）
- 不要为了逃避执行而删除任务

每个事项必须包含：id（必填）。`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要删除的待办事项',
          items: {
            type: 'object',
            properties: { id: { type: 'integer', description: '要删除的待办事项 ID' } },
            required: ['id'],
          },
        },
      },
      required: ['items'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return errorJson('无效的JSON参数');
      const items = Array.isArray(args.items) ? args.items as Record<string, unknown>[] : [];
      let count = 0;
      for (const item of items) {
        const id = Number(item.id);
        if (sessionId != null) await this.sessionTodoMapper.delete(id, sessionId);
        count++;
      }
      const todos = sessionId != null ? await this.sessionTodoMapper.selectBySessionId(sessionId) : [];
      return toJson({ todos, message: `已删除 ${count} 个事项` });
    } catch (e) {
      harnessLog('error', 'TaskDeleteTool execution failed', e);
      return errorJson((e as Error).message);
    }
  }
}
