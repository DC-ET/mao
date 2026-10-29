import { BaseTool } from '../tool.js';
import { asInt, asIntStrict, asText, errorJson, parseObject, toJson } from '../json.js';
import type { AtomicBoolean } from '../../atomic-boolean.js';
import type { BackgroundSubagentManager } from '../../delegate/background-subagent-manager.js';
import { BUILTIN_AGENT_TYPES, normalizeAgentType, type AgentDefinitionRegistry } from '../../delegate/agent-definition-registry.js';
import { ToolCallContext } from '../tool-call-context.js';

export class SpawnSubagentTool extends BaseTool {
  constructor(
    private readonly manager: BackgroundSubagentManager,
    private readonly definitionRegistry?: AgentDefinitionRegistry,
  ) { super(); }

  getName(): string { return 'spawn_subagent'; }
  getDescription(): string {
    return '在后台启动一个子代理执行任务，立即返回任务句柄，主代理可继续主线工作。'
      + '适用于：可并行、无强依赖的分支工作；主代理无需立即等待结果。'
      + '完成后子代理会主动汇报结果。角色见 agent_type：default 通用 / explorer 调研 / reviewer 审查 / worker 写代码。';
  }
  getToolPrompt(): string {
    return '## 后台子代理\n\n'
      + '使用 `spawn_subagent` 在后台派发子代理，返回 `task_id` 和 `child_session_id`，主代理继续执行主线。\n'
      + '配套工具：`subagent_followup` 追问/纠偏、`check_subagent` 查看进度、`cancel_subagent` 取消、`wait_subagents` 等待全部完成。\n\n'
      + '**角色选型：**\n'
      + '- `default`：通用并行，完整继承主代理能力；不确定时首选\n'
      + '- `explorer`：代码库调研/问答，只读；多问题可并行、结论默认可信\n'
      + '- `reviewer`：代码审查，只读问题清单；修复派 worker，可 followup 复查\n'
      + '- `worker`：实现与修改代码；多 worker 需划分互不重叠的文件/模块归属\n\n'
      + '**委派纪律：**\n'
      + '1. 先快速分析整体任务，区分关键路径阻塞任务与可并行 sidecar；关键路径勿外包后干等\n'
      + '2. 子任务必须具体、自包含（目标、输入、期望输出、约束），实质性推进主任务\n'
      + '   派发时通过 `title` 参数提供简短可区分的标题（建议 4-12 个字概括任务，不要照抄任务指令），便于并行子代理的识别与跟踪\n'
      + '3. 不要在同一未解决线程上重复派发；并行子任务写入范围不得重叠\n'
      + '4. 代码改动优先 worker；审查用 reviewer 且不要让其改代码\n'
      + '5. 下一步需要子代理结果时直接调用 `wait_subagents`（阻塞到全部结束或超时返回）；运行期间做不重叠的本地工作，禁止用 sleep 轮询等待\n'
      + '6. 子代理返回后先快速审查改动/结论，再集成或细化\n\n'
      + '注意：后台子代理无法与用户交互，也不能再派生后台子代理。\n'
      + '主代理在主线完成时若仍有后台子代理运行，会自动挂起等待，无需手动等待。';
  }
  getInputSchema(): Record<string, unknown> {
    const roleList = this.definitionRegistry
      ? this.definitionRegistry.getAllDefinitions().map((d) => `- ${d.name}：${d.description}`).join('\n')
      : BUILTIN_AGENT_TYPES.map((name) => `- ${name}`).join('\n');
    return {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          enum: [...BUILTIN_AGENT_TYPES],
          description: '子代理类型：\n' + roleList,
        },
        task: { type: 'string', description: '要派发的任务描述，包含目标、输入上下文、期望输出与约束' },
        title: { type: 'string', description: '子代理会话标题（可选）。建议 4-12 个字概括任务目标，便于在并行子代理列表中区分；不传时系统按任务描述自动生成。' },
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
    const result = await this.manager.spawn(sessionId, normalizeAgentType(agentType), task, toolCallId, asText(args.title));
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
    // Number('')/Number(false)/Number([]) 都是 0、Number([5]) 是 5，能通过 isInteger 校验，
    // 把类型混淆入参当真实任务 id 去取消；asIntStrict 只接受本身就是整数的 number 或纯整数字符串
    const taskId = asIntStrict(args.task_id, 0);
    if (!(taskId > 0)) return errorJson('参数 task_id 必须是整数');
    return toJson(await this.manager.cancel(sessionId, taskId));
  }
}

const DEFAULT_WAIT_SUBAGENTS_TIMEOUT_SECONDS = 30 * 60;
/** 等待上界：有限大数（如 1e308）× 1000 会溢出为 Infinity，必须在换算后钳制，否则 waitForAll 的 deadline 永不到期。 */
const MAX_WAIT_SUBAGENTS_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export class WaitSubagentsTool extends BaseTool {
  constructor(
    private readonly manager: BackgroundSubagentManager,
    private readonly getCancelFlag?: (sessionId: number) => AtomicBoolean | undefined,
  ) { super(); }

  getName(): string { return 'wait_subagents'; }
  getDescription(): string {
    return '等待当前会话全部后台子代理结束，返回汇总结果。默认最多等待 30 分钟；超时会返回当前运行状态，由主代理决定继续等待、取消或执行其他操作。'
      + '需要子代理结果时直接调用本工具，不要用 `check_subagent` 配合固定 sleep 轮询。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: '最多等待秒数，默认 1800（30 分钟）；超时后工具返回当前子代理状态而不继续阻塞。' },
      },
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    if (sessionId == null) return errorJson('缺少会话 ID');
    const args = parseObject(argumentsJson);
    const rawTimeoutSeconds = args && args.timeout_seconds != null ? args.timeout_seconds : DEFAULT_WAIT_SUBAGENTS_TIMEOUT_SECONDS;
    // asInt 对 ''/非数字回落默认值：裸 Number('') = 0 会把「未提供」变成 0ms 即刻假超时；负数仍显式拒绝
    const timeoutSeconds = asInt(rawTimeoutSeconds, DEFAULT_WAIT_SUBAGENTS_TIMEOUT_SECONDS);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) return errorJson('参数 timeout_seconds 必须是非负数字');

    const waitResult = await this.manager.waitForAll(
      sessionId,
      this.getCancelFlag?.(sessionId) ?? null,
      // 有限大数 × 1000 溢出为 Infinity 时 deadline 永不到期，工具会无限阻塞整个 agent 循环
      Math.min(timeoutSeconds * 1000, MAX_WAIT_SUBAGENTS_TIMEOUT_MS),
    );
    const results = await this.manager.consumeResults(sessionId);
    const list = Object.values(results).map((raw) => {
      try { return JSON.parse(raw) as unknown; } catch { return raw; }
    });
    const response: Record<string, unknown> = {
      completed: list.length,
      results: list,
      timed_out: waitResult.timedOut,
      all_completed: waitResult.completed,
    };
    if (waitResult.timedOut) {
      response.background_subagents = await this.manager.progress(sessionId, null);
    }
    return toJson(response);
  }
}
