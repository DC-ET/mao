import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import type { AgentLoop } from '../../core/agent-loop.js';
import type { BackgroundSubagentManager } from '../../delegate/background-subagent-manager.js';
import { ToolCallContext } from '../tool-call-context.js';

export class SpawnSubagentTool extends BaseTool {
  constructor(private readonly manager: BackgroundSubagentManager) { super(); }

  getName(): string { return 'spawn_subagent'; }
  getDescription(): string {
    return '在后台启动一个子代理执行任务，立即返回任务句柄，主代理可继续主线工作。'
      + '适用于：可并行、无强依赖的分支工作；主代理无需立即等待结果。'
      + '完成后子代理会主动汇报结果。';
  }
  getToolPrompt(): string {
    return '## 后台子代理\n\n'
      + '使用 `spawn_subagent` 在后台派发子代理，返回 `task_id` 和 `child_session_id`，主代理继续执行主线。\n'
      + '配套工具：`subagent_followup` 追问/纠偏、`check_subagent` 查看进度、`cancel_subagent` 取消、`wait_subagents` 等待全部完成。\n'
      + '注意：后台子代理无法与用户交互，也不能再派生后台子代理。\n'
      + '主代理在主线完成时若仍有后台子代理运行，会自动挂起等待，无需手动等待。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        agent_type: { type: 'string', description: '子代理类型（researcher/reviewer/coder）' },
        task: { type: 'string', description: '要派发的任务描述，包含目标、输入上下文、期望输出与约束' },
      },
      required: ['agent_type', 'task'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    const args = parseObject(argumentsJson);
    if (!args) return errorJson('无效的JSON参数');
    const agentType = asText(args.agent_type);
    const task = asText(args.task);
    if (!agentType || !task) return errorJson('缺少必填参数: agent_type, task');
    if (sessionId == null) return errorJson('缺少会话 ID');
    const toolCallId = ToolCallContext.getToolCallId();
    if (!toolCallId) return errorJson('缺少父工具调用 ID');
    const result = await this.manager.spawn(sessionId, agentType, task, toolCallId);
    if (!result.ok) return errorJson(result.error ?? '创建后台子代理失败');
    return toJson({
      success: true,
      task_id: result.taskId,
      child_session_id: result.childSessionId,
      status: 'RUNNING',
    });
  }
}

export class SubagentFollowupTool extends BaseTool {
  constructor(private readonly manager: BackgroundSubagentManager) { super(); }

  getName(): string { return 'subagent_followup'; }
  getDescription(): string {
    return '对既有后台子代理会话发起追问。若子代理正在运行，本调用会被理解为纠偏：中断当前执行，追加纠偏消息，并启动新的后台执行。';
  }
  getToolPrompt(): string {
    return '## 子代理追问与纠偏\n\n'
      + '使用 `subagent_followup` 对 `spawn_subagent` 返回的 `child_session_id` 发起追问。\n'
      + '如果子代理已完成或空闲，会复用其历史上下文启动一轮新的后台追问。\n'
      + '如果子代理正在运行，本次追问会作为纠偏：系统会中断当前执行，追加纠偏消息，再启动新的后台执行。\n'
      + '`subagent_followup` 立即返回新的 `task_id`，后续使用 `check_subagent` 或 `wait_subagents` 获取结果。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        child_session_id: { type: 'integer', description: '要追问或纠偏的子代理会话 ID，来自 spawn_subagent 或 subagent_followup 返回值' },
        task: { type: 'string', description: '追问或纠偏消息。应说明最新目标、修正内容和期望输出。' },
      },
      required: ['child_session_id', 'task'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    const args = parseObject(argumentsJson);
    if (!args) return errorJson('无效的JSON参数');
    if (sessionId == null) return errorJson('缺少会话 ID');
    const rawChildSessionId = args.child_session_id;
    const childSessionId = rawChildSessionId != null ? Number(rawChildSessionId) : null;
    const task = asText(args.task);
    if (childSessionId == null || !Number.isInteger(childSessionId) || !task) {
      return errorJson('缺少必填参数: child_session_id, task');
    }
    const toolCallId = ToolCallContext.getToolCallId();
    if (!toolCallId) return errorJson('缺少父工具调用 ID');
    const result = await this.manager.followup(sessionId, childSessionId, task, toolCallId);
    if (!result.ok) return errorJson(result.error ?? '创建子代理追问任务失败');
    return toJson({
      success: true,
      task_id: result.taskId,
      child_session_id: result.childSessionId,
      status: 'RUNNING',
      corrected: result.corrected === true,
    });
  }
}

export class CheckSubagentTool extends BaseTool {
  constructor(private readonly manager: BackgroundSubagentManager) { super(); }

  getName(): string { return 'check_subagent'; }
  getDescription(): string {
    return '查看后台子代理进度。传入 task_id 查询单个；不传则列出当前会话全部后台子代理状态。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: '要查询的后台子代理任务 ID（spawn_subagent 返回的 task_id）；缺省列出全部' },
      },
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    if (sessionId == null) return errorJson('缺少会话 ID');
    const args = parseObject(argumentsJson);
    const rawTaskId = args && args.task_id != null ? args.task_id : null;
    const taskId = rawTaskId != null ? Number(rawTaskId) : null;
    if (taskId != null && !Number.isInteger(taskId)) return errorJson('参数 task_id 必须是整数');
    const result = await this.manager.progress(sessionId, taskId);
    if (taskId != null) return toJson(result ?? { error: '后台子代理不存在: ' + taskId });
    return toJson({ background_subagents: result });
  }
}

export class CancelSubagentTool extends BaseTool {
  constructor(private readonly manager: BackgroundSubagentManager) { super(); }

  getName(): string { return 'cancel_subagent'; }
  getDescription(): string {
    return '取消指定的后台子代理。子代理会停止执行并进入已取消状态，取消结果会回传给主代理。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: '要取消的后台子代理任务 ID（spawn_subagent 返回的 task_id）' },
      },
      required: ['task_id'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    if (sessionId == null) return errorJson('缺少会话 ID');
    const args = parseObject(argumentsJson);
    if (!args || args.task_id == null) return errorJson('缺少必填参数: task_id');
    const taskId = Number(args.task_id);
    if (!Number.isInteger(taskId)) return errorJson('参数 task_id 必须是整数');
    return toJson(await this.manager.cancel(sessionId, taskId));
  }
}

export class WaitSubagentsTool extends BaseTool {
  constructor(
    private readonly manager: BackgroundSubagentManager,
    private readonly agentLoop: AgentLoop,
  ) { super(); }

  getName(): string { return 'wait_subagents'; }
  getDescription(): string {
    return '等待当前会话全部后台子代理结束，返回汇总结果。主代理在主线完成时会自动挂起等待，一般无需主动调用。';
  }
  getInputSchema(): Record<string, unknown> { return { type: 'object', properties: {} }; }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(_argumentsJson: string, sessionId: number | null): Promise<string> {
    if (sessionId == null) return errorJson('缺少会话 ID');
    const cancelFlag = this.agentLoop.getCancelFlag(sessionId);
    await this.manager.waitForAll(sessionId, cancelFlag);
    const results = await this.manager.consumeResults(sessionId);
    const list = Object.values(results).map((raw) => {
      try { return JSON.parse(raw) as unknown; } catch { return raw; }
    });
    return toJson({ completed: list.length, results: list });
  }
}
