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
    return '创建定时任务。任务将按照指定的 cron 计划自动执行 Agent。适用于：定时检查新股、每日生成报告、定期巡检等场景。一次性提醒（固定某月某日执行一次）执行后会自动完结。任务创建后绑定当前 Agent，并在创建时的会话中累积执行历史。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称，如\'新股申购检查\'' },
        prompt: { type: 'string', description: '触发时执行的任务本体：只描述要做的具体工作与输出要求，不要包含执行频率或调度措辞（频率由 cron_expression 控制）。' },
        cron_expression: { type: 'string', description: 'Spring cron 表达式（6位：秒 分 时 日 月 周），控制执行频率。' },
        once: { type: 'boolean', description: '是否一次性任务（执行一次后自动完结）。固定某月某日的提醒类任务应传 true；不传时按 cron 形态自动判定。' },
      },
      required: ['name', 'prompt', 'cron_expression'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }
  getToolPrompt(): string {
    return `## create_scheduled_task 使用指南

当用户希望创建定时自动执行的任务时使用此工具。

### 执行方式
- 任务触发时在创建时的会话中执行，结果会出现在该会话中
- 如果触发时用户正在对话，任务消息会自动排队，等当前对话结束后执行

### cron 表达式规则
- 格式：秒 分 时 日 月 周（Spring 6位 cron）
- "每天早上9点" → "0 0 9 * * ?"
- "每30分钟" → "0 */30 * * * ?"
- "工作日早上9点" → "0 0 9 * * MON-FRI"
- "每周一上午10点" → "0 0 10 * * MON"
- "每月1号早上9点" → "0 0 9 1 * ?"

### 一次性任务规则
- 只执行一次的提醒（如"8月15日早上8点提醒我"）用固定月+日的 cron："0 0 8 15 8 ?"，并传 once=true
- 一次性任务执行一次后自动完结（finished），不会再触发，也无需用户手动删除

### prompt 编写要求（重要）
- prompt 是触发时 Agent 要执行的**任务本体**，不是对任务的描述或设置请求
- 执行频率只写在 cron_expression 里，prompt 中不要出现"每天/每小时/每周"等调度措辞
- 严禁在 prompt 中要求创建、修改或删除定时任务——触发时的系统提示会要求 Agent 直接执行任务本身
- 不要引用本会话的临时文件路径（如 runtime 目录下的 skills），触发执行时这些路径可能已失效；技能请写技能名称
- 必须完整、自包含，因为执行时 Agent 只有任务历史，没有用户实时对话
- 应包含明确的输出要求
- 好的示例："查询昨日 GMV 总额。使用 bigdata-cli 技能（按其 SKILL.md 流程）查询官方 GMV 指标，报告统计日期、GMV 总额、币种、口径摘要；无法确认口径时说明阻塞原因，不编造金额。"
- 差的示例："每天执行一次，向当前飞书用户报告前一天的 GMV 总额"（"每天"属于 cron；"向当前飞书用户报告"在定时触发上下文中含义不明，结果会自动推送回创建会话的渠道）
`;
  }

  protected async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const name = asText(args.name);
      const prompt = asText(args.prompt);
      const cronExpression = asText(args.cron_expression);
      const once = typeof args.once === 'boolean' ? args.once : undefined;
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
      const task = await this.scheduledTaskService.createTask(resolvedUserId, agentId, sessionId!, name!, prompt!, cronExpression!, once);
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
  getDescription(): string { return '更新已有定时任务的名称、prompt、cron、once 或状态。'; }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        cron_expression: { type: 'string' },
        status: { type: 'string' },
        once: { type: 'boolean', description: '是否一次性任务（执行一次后自动完结）。' },
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
        taskId, userId, asText(args.name), asText(args.prompt), asText(args.cron_expression), asText(args.status),
        typeof args.once === 'boolean' ? args.once : null);
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
