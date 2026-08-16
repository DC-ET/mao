import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import type { SessionService } from '../../deps.js';
import { harnessLog } from '../../log.js';
import type { ScheduledTask, ScheduledTaskService } from '../../../schedule/scheduled-task.service.js';

export class CreateScheduledTaskTool extends BaseTool {
  constructor(
    private readonly scheduledTaskService: ScheduledTaskService,
    private readonly sessionService: SessionService,
  ) { super(); }

  getName(): string { return 'create_scheduled_task'; }
  getDescription(): string {
    return '创建定时任务。任务将按照指定的 cron 计划自动执行 Agent。适用于：定时检查新股、每日生成报告、定期巡检等场景。任务创建后会绑定当前 Agent，拥有专属 Session 用于累积执行历史。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称，如\'新股申购检查\'' },
        prompt: { type: 'string', description: '任务触发时执行的 prompt。应完整、自包含，包含足够上下文。' },
        cron_expression: { type: 'string', description: 'Spring cron 表达式（6位：秒 分 时 日 月 周）。' },
      },
      required: ['name', 'prompt', 'cron_expression'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }
  getToolPrompt(): string {
    return `## create_scheduled_task 使用指南

当用户希望创建定时自动执行的任务时使用此工具。

### 执行方式
- 任务在当前对话 Session 中执行，结果会直接出现在当前对话中
- 如果触发时用户正在对话，任务消息会自动排队，等当前对话结束后执行

### cron 表达式规则
- 格式：秒 分 时 日 月 周（Spring 6位 cron）
- "每天早上9点" → "0 0 9 * * ?"
- "每30分钟" → "0 */30 * * * ?"
- "工作日早上9点" → "0 0 9 * * MON-FRI"
- "每周一上午10点" → "0 0 10 * * MON"
- "每月1号早上9点" → "0 0 9 1 * ?"

### prompt 编写要求
- 必须完整、自包含，因为执行时 Agent 只有任务历史，没有用户实时对话
- 应包含明确的输出要求
- 好的示例："检查今日是否有新股可申购。如果有，列出新股代码、名称、申购价格和申购上限；如果没有新股，简要说明今日无新股即可。"
- 差的示例："检查新股"（太简短，缺少上下文和输出要求）
`;
  }

  protected async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const name = asText(args.name);
      const prompt = asText(args.prompt);
      const cronExpression = asText(args.cron_expression);
      let agentId: number | null = null;
      let resolvedUserId = userId;
      if (sessionId != null) {
        const current = await this.sessionService.getSession(sessionId);
        if (current) {
          agentId = current.agentId ?? null;
          if (resolvedUserId == null) resolvedUserId = current.userId ?? null;
        }
      }
      if (agentId == null) return errorJson('无法获取当前 Agent 信息，请确保在有效会话中创建定时任务');
      if (resolvedUserId == null) return errorJson('无法获取当前用户信息');
      const task = await this.scheduledTaskService.createTask(resolvedUserId, agentId, sessionId!, name!, prompt!, cronExpression!);
      return toJson({
        success: true,
        task_id: task.id,
        name: task.name,
        cron_expression: task.cronExpression,
        next_fire_time: task.nextFireTime != null ? String(task.nextFireTime) : null,
        session_id: task.sessionId,
        message: `定时任务 '${name}' 已创建，下次执行时间: ${task.nextFireTime}`,
      });
    } catch (e) {
      harnessLog('error', 'CreateScheduledTaskTool failed', e);
      return errorJson((e as Error).message ?? '未知错误');
    }
  }
}

export class ListScheduledTasksTool extends BaseTool {
  constructor(private readonly scheduledTaskService: ScheduledTaskService) { super(); }
  getName(): string { return 'list_scheduled_tasks'; }
  getDescription(): string { return '列出当前用户的定时任务。'; }
  getInputSchema(): Record<string, unknown> { return { type: 'object', properties: {} }; }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithUser(_argumentsJson: string, sessionId: number | null, userId: number | null, _workspace: string | null): Promise<string> {
    try {
      let resolved = userId;
      if (resolved == null && sessionId != null) {
        /* userId required */
      }
      if (resolved == null) return errorJson('无法获取当前用户信息');
      const tasks = await this.scheduledTaskService.listByUser(resolved);
      return toJson({ tasks, total: tasks.length });
    } catch (e) {
      return errorJson((e as Error).message);
    }
  }
}

export class UpdateScheduledTaskTool extends BaseTool {
  constructor(private readonly scheduledTaskService: ScheduledTaskService) { super(); }
  getName(): string { return 'update_scheduled_task'; }
  getDescription(): string { return '更新已有定时任务的名称、prompt、cron 或状态。'; }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        cron_expression: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['task_id'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithUser(argumentsJson: string, _sessionId: number | null, userId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return errorJson('缺少必填参数: task_id');
      if (userId == null) return errorJson('无法获取当前用户信息');
      const task = await this.scheduledTaskService.updateTask(
        taskId, userId, asText(args.name), asText(args.prompt), asText(args.cron_expression), asText(args.status));
      return toJson({ success: true, task });
    } catch (e) {
      return errorJson((e as Error).message);
    }
  }
}

export class DeleteScheduledTaskTool extends BaseTool {
  constructor(private readonly scheduledTaskService: ScheduledTaskService) { super(); }
  getName(): string { return 'delete_scheduled_task'; }
  getDescription(): string { return '删除当前用户的定时任务。'; }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithUser(argumentsJson: string, _sessionId: number | null, userId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return errorJson('缺少必填参数: task_id');
      if (userId == null) return errorJson('无法获取当前用户信息');
      await this.scheduledTaskService.deleteTask(taskId, userId);
      return toJson({ success: true, task_id: taskId });
    } catch (e) {
      return errorJson((e as Error).message);
    }
  }
}
