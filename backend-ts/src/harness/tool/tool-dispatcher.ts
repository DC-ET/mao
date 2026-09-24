import { harnessLog } from '../log.js';
import type { LlmModelConfig } from '../llm/chat-request.js';
import type { Session, SessionMapper, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import { isFeishuChannelSession } from './feishu-channel-tool.js';
import type { LocalToolExecutor } from '../local/local-tool-executor.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';
import { normalizeAskUserQuestionsArgs } from './ask-user-questions-normalize.js';
import type { DangerAssessor } from './danger-assessor.js';
import type { Tool } from './tool.js';
import { callTool } from './tool.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolDescriptor } from './tool-descriptor.js';
import type { ToolInvocation } from './tool-invocation.js';
import type { ToolResult } from './tool-result.js';
import { normalizeToolResult } from './tool-result.js';
import { permissionLevelFromString, type PermissionLevel } from './permission-level.js';
import type { BackgroundTaskManager } from '../core/background-task-manager.js';
import { parseObject } from './json.js';
import type { TaskNotificationDelivery } from '../../notification/task/types.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../../usage/llm-call-context.js';

/**
 * 飞书进度卡上的提问表单。
 * 只有本会话正在执行的进度卡可以挂；挂上之后跳过离线 Webhook。
 */
export interface FeishuAskMount {
  hasRunningProgress(sessionId: number): boolean;
  /** 写入表单并刷新卡片。返回 true 表示卡片上已经带上这组提问。 */
  mount(sessionId: number, requestId: string, questions: Array<Record<string, unknown>>): Promise<boolean>;
  /** 这组提问结束（提交、超时、取消、另一端作答）后清掉表单。已不在时不得再刷一张执行中的卡。 */
  clearRequest(sessionId: number, requestId: string): void;
}

/** 用户离线时 ask_user_questions 的 Webhook 通知能力（由 notification/task 提供）。 */
export interface AskUserOfflineNotifier {
  prepareAskUser(sessionId: number, userId: number, requestId: string, title: string | null): Promise<TaskNotificationDelivery | null>;
  suppressPending(delivery: TaskNotificationDelivery | null): Promise<void>;
}

const ASK_USER_QUESTIONS = 'ask_user_questions';
const MCP_TOOL_PREFIX = 'mcp__';
const SERVER_ONLY_TOOLS = new Set([
  'task_create', 'task_update', 'task_list', 'task_delete',
  'spawn_subagent', 'subagent_followup', 'check_subagent', 'cancel_subagent', 'wait_subagents',
  'web_search', 'open_web_page', 'generate_image', 'edit_image',
  'send_wechat_image', 'send_wechat_file',
]);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export class IllegalArgumentException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalArgumentException';
  }
}

export class ToolDispatcher {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly localToolExecutor: LocalToolExecutor,
    private readonly dangerAssessor: DangerAssessor,
    private readonly sessionMapper: SessionMapper,
    private readonly streamingWsRegistry: StreamingWsRegistry,
    private readonly askUserQuestionsRegistry: AskUserQuestionsRegistry,
    private readonly localToolSessionRegistry: LocalToolSessionRegistry,
    private readonly treeSignalPublisher: SessionTreeSignalPublisher,
    private readonly backgroundTaskManager?: BackgroundTaskManager | null,
    private readonly askUserOfflineNotifier?: AskUserOfflineNotifier | null,
    private readonly feishuAsk: FeishuAskMount | null = null,
  ) {}

  /**
   * Overloads match Java ToolDispatcher:
   * (name, args)
   * (name, args, workspace)
   * (name, args, mode, sessionId, workspace)
   * (name, args, mode, sessionId, workspace, perm, model)
   * (name, args, mode, sessionId, userId, workspace, perm, model)
   * (name, args, mode, sessionId, userId, workspace, perm, model, sessionTools)
   */
  dispatch(toolName: string, argumentsJson: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown, f?: unknown, g?: unknown, h?: unknown): Promise<string> | string {
    const n = arguments.length;
    if (n <= 2) return this.dispatchCloud(toolName, argumentsJson, null);
    if (n === 3) return this.dispatchCloud(toolName, argumentsJson, a as string | null);
    if (n === 5) {
      return this.dispatchFull(toolName, argumentsJson, a as string, b as number, null, c as string, null, null, null);
    }
    if (n === 7) {
      return this.dispatchFull(toolName, argumentsJson, a as string, b as number, null, c as string, d as string, e as LlmModelConfig | null, null);
    }
    if (n === 8) {
      return this.dispatchFull(toolName, argumentsJson, a as string, b as number, c as number, d as string, e as string, f as LlmModelConfig | null, null, null);
    }
    if (n === 9) {
      return this.dispatchFull(toolName, argumentsJson, a as string, b as number, c as number, d as string, e as string, f as LlmModelConfig | null, g as Tool[] | null, null);
    }
    return this.dispatchFull(toolName, argumentsJson, a as string, b as number, c as number, d as string, e as string, f as LlmModelConfig | null, g as Tool[] | null, h as number | null);
  }

  /**
   * 统一执行入口：显式 ToolInvocation → ToolResult。
   * 异常统一归一为 status:'error' 的 ToolResult，不向上抛给调用方。
   */
  async dispatchInvocation(invocation: ToolInvocation): Promise<ToolResult> {
    const started = Date.now();
    try {
      const raw = await this.dispatchFull(
        invocation.toolName, invocation.argumentsJson, invocation.executionMode,
        invocation.sessionId, invocation.userId, invocation.workspace,
        invocation.permissionLevel, invocation.modelConfig, invocation.sessionTools,
        invocation.executionUserId ?? null,
      );
      return normalizeToolResult(invocation.callId, raw, Date.now() - started);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        callId: invocation.callId,
        status: 'error',
        content: 'Tool execution failed: ' + message,
        errorMessage: message,
        durationMs: Date.now() - started,
      };
    }
  }

  private resolveDescriptor(toolName: string, sessionTools: Tool[] | null): ToolDescriptor {
    const tool = this.toolRegistry.getTool(toolName);
    const instance = tool ?? sessionTools?.find((t) => t.getName() === toolName);
    const getter = (instance as { getDescriptor?: () => ToolDescriptor } | null | undefined)?.getDescriptor;
    if (typeof getter === 'function') {
      return getter.call(instance);
    }
    return { name: toolName, source: 'builtin', executor: 'server' };
  }

  private async dispatchCloud(toolName: string, argumentsJson: string, workspace: string | null): Promise<string> {
    harnessLog('debug', `Dispatching tool call (cloud): ${toolName}`);
    const tool = this.toolRegistry.getTool(toolName);
    if (tool) {
      return await callTool(tool, argumentsJson, undefined, undefined, workspace);
    }
    throw new IllegalArgumentException('Unknown tool: ' + toolName);
  }

  private async dispatchFull(
    toolName: string,
    argumentsJson: string,
    executionMode: string | null,
    sessionId: number | null,
    userId: number | null,
    workspace: string | null,
    permissionLevel: string | null,
    modelConfig: LlmModelConfig | null,
    sessionTools: Tool[] | null,
    executionUserId: number | null = null,
  ): Promise<string> {
    const descriptor = this.resolveDescriptor(toolName, sessionTools);
    if (toolName === ASK_USER_QUESTIONS) {
      return this.dispatchAskUserQuestions(argumentsJson, sessionId);
    }
    if (SERVER_ONLY_TOOLS.has(toolName) || toolName.startsWith('page_')) {
      const tool = this.toolRegistry.getTool(toolName);
      if (tool) {
        return await callTool(tool, argumentsJson, sessionId, userId, workspace);
      }
      throw new IllegalArgumentException('Unknown tool: ' + toolName);
    }
    if (executionMode === 'LOCAL') {
      let latest = permissionLevel;
      if (sessionId != null) {
        const session = await this.sessionMapper.selectById(sessionId);
        if (session?.permissionLevel) latest = session.permissionLevel;
      }
      const level = permissionLevelFromString(latest);
      const decision = await this.shouldRequireApproval(
        descriptor, toolName, level, argumentsJson, modelConfig, sessionId, executionUserId ?? userId,
      );
      if (toolName === 'shell' && this.backgroundTaskManager && isLocalShellAsyncExec(argumentsJson)) {
        return this.dispatchLocalShellAsync(
          argumentsJson, sessionId, workspace, decision.needApproval, decision.dangerReason,
        );
      }
      return this.localToolExecutor.execute(sessionId, toolName, argumentsJson, workspace, decision.needApproval, decision.dangerReason);
    }

    let tool = this.toolRegistry.getTool(toolName);
    if (!tool && sessionTools) {
      tool = sessionTools.find((t) => t.getName() === toolName);
    }
    if (tool) {
      const toolUserId = toolName === 'shell' ? executionUserId ?? userId : userId;
      return await callTool(tool, argumentsJson, sessionId, toolUserId, workspace);
    }
    throw new IllegalArgumentException('Unknown tool: ' + toolName);
  }

  private async dispatchAskUserQuestions(argumentsJson: string, sessionId: number | null): Promise<string> {
    let userId = sessionId != null ? await this.localToolSessionRegistry.getUserIdForSession(sessionId) : null;
    let session: Session | null = null;
    if (userId == null && sessionId != null) {
      session = await this.sessionMapper.selectById(sessionId);
      if (session == null) return JSON.stringify({ error: `Session not found: ${sessionId}` });
      userId = session.userId ?? null;
    }
    if (userId == null) {
      return JSON.stringify({ error: 'No connected client to receive questions' });
    }
    if (session == null && sessionId != null && this.feishuAsk != null) {
      session = await this.sessionMapper.selectById(sessionId);
    }
    const feishuChannel = this.feishuAsk != null && sessionId != null
      && isFeishuChannelSession(session?.projectKey, session?.workspace);
    const userOnline = this.streamingWsRegistry.hasConnection(userId);
    let questions: Array<Record<string, unknown>> = [];
    let metadata: Record<string, unknown> | null = null;
    try {
      // 模型偶发把 questions 输出成字符串化 JSON / unicode 转义，统一在此归一化
      const args = normalizeAskUserQuestionsArgs(argumentsJson);
      questions = args.questions;
      metadata = args.metadata;
      if (questions.length === 0) {
        harnessLog('warn', `ask_user_questions normalized to 0 questions, raw: ${argumentsJson.slice(0, 200)}`);
      }
    } catch (e) {
      harnessLog('warn', `Failed to parse ask_user_questions arguments: ${(e as Error).message}`);
    }
    // 飞书没有进度卡、桌面也不在线：不要在内存里空等。模型改用文字继续。
    if (feishuChannel && !userOnline && !this.feishuAsk!.hasRunningProgress(sessionId!)) {
      harnessLog('info', `ask_user_questions skipped: feishu session ${sessionId} has no progress card and no websocket`);
      return JSON.stringify({ error: '当前通道无法向用户提问' });
    }
    const requestId = this.askUserQuestionsRegistry.register(sessionId!, questions, metadata);
    this.treeSignalPublisher.publishForSession(sessionId!);
    // 先挂上 wait，再把问题交给用户。否则飞书 PATCH 返回后用户立刻提交时，complete 会先于
    // waitForAnswer 删掉登记，等待方会当成「没有这道题」。WebSocket 也要在刷新卡片之前发出，
    // 避免用户已经在卡片上答完，桌面端却又被推开一块已结束的提问面板。
    const waiting = this.askUserQuestionsRegistry.waitForAnswer(sessionId!, requestId);
    const data: Record<string, unknown> = { requestId, questions };
    if (metadata) data.metadata = metadata;
    this.streamingWsRegistry.send(userId, wsEvent('ask_user_questions', sessionId, data));
    let formMounted = false;
    if (feishuChannel && questions.length > 0 && this.feishuAsk!.hasRunningProgress(sessionId!)) {
      try {
        formMounted = await this.feishuAsk!.mount(sessionId!, requestId, questions);
      } catch (e) {
        harnessLog('warn', `Failed to mount feishu ask form: sessionId=${sessionId}, error=${(e as Error).message}`);
      }
    }
    // 用户离线且没挂上飞书表单：复用任务通知的 Webhook 提醒用户回来回答。
    // 进度卡已经带上表单时不再发，避免用户在飞书里就能答还被叫去网页。
    let offlineDelivery: TaskNotificationDelivery | null = null;
    if (!userOnline && !formMounted && sessionId != null && this.askUserOfflineNotifier) {
      session ??= await this.sessionMapper.selectById(sessionId);
      try {
        offlineDelivery = await this.askUserOfflineNotifier.prepareAskUser(sessionId, userId, requestId, session?.title ?? null);
      } catch (e) {
        harnessLog('warn', `Failed to prepare ask_user webhook notification: sessionId=${sessionId}, error=${(e as Error).message}`);
      }
    }
    const result = await waiting;
    if (offlineDelivery) {
      const deliveryToSuppress = offlineDelivery;
      try {
        await this.askUserOfflineNotifier?.suppressPending(deliveryToSuppress);
      } catch (e) {
        harnessLog('warn', `Failed to suppress ask_user webhook notification: deliveryId=${deliveryToSuppress.id}, error=${(e as Error).message}`);
      }
    }
    if (feishuChannel) {
      try {
        this.feishuAsk!.clearRequest(sessionId!, requestId);
      } catch (e) {
        harnessLog('warn', `Failed to clear feishu ask form: sessionId=${sessionId}, requestId=${requestId}, error=${(e as Error).message}`);
      }
    }
    if (!result.answered || result.cancelled) {
      this.streamingWsRegistry.send(userId, wsEvent('ask_user_questions_cancelled', sessionId, { requestId }));
      this.treeSignalPublisher.publishForSession(sessionId!);
    }
    return result.resultJson;
  }

  private async shouldRequireApproval(
    descriptor: ToolDescriptor,
    toolName: string,
    level: PermissionLevel,
    argumentsJson: string,
    modelConfig: LlmModelConfig | null,
    sessionId: number | null,
    userId: number | null,
  ): Promise<{ needApproval: boolean; dangerReason: string | null }> {
    // MCP 识别：descriptor.source 优先，mcp__ 前缀保留为 fallback（缺 descriptor 的直接实现/旧名场景）
    const isMcpTool = descriptor?.source === 'mcp' || (toolName != null && toolName.startsWith(MCP_TOOL_PREFIX));
    switch (level) {
      case 'READ_ONLY':
        return { needApproval: this.isWriteOrShellTool(toolName) || isMcpTool, dangerReason: null };
      case 'READ_WRITE':
        return { needApproval: toolName === 'shell' || isMcpTool, dangerReason: null };
      case 'SMART': {
        if (toolName !== 'shell' && !isMcpTool) return { needApproval: false, dangerReason: null };
        if (isMcpTool) return { needApproval: true, dangerReason: 'MCP 工具调用需要用户确认' };
        if (modelConfig == null) {
          harnessLog('warn', 'SMART mode: no modelConfig available, defaulting to approval required');
          return { needApproval: true, dangerReason: '无法进行安全评估，默认需要审批' };
        }
        const result = await LlmCallContext.runAsync({
          scene: LLM_CALL_SCENES.DANGER_ASSESS,
          userId,
          sessionId,
          agentId: null,
        }, async () => this.dangerAssessor.assess(argumentsJson, modelConfig));
        return { needApproval: result.dangerous, dangerReason: result.reason };
      }
      case 'FULL':
        return { needApproval: false, dangerReason: null };
    }
  }

  private isWriteOrShellTool(toolName: string): boolean {
    return toolName === 'shell' || WRITE_TOOLS.has(toolName);
  }

  /**
   * 对齐云端：先把命令下发到已连接的桌面端（会话已创建、stdin 已写入），
   * 再把「等待输出」提交到后台任务。未连接时与同步路径一样立即报错。
   */
  private async dispatchLocalShellAsync(
    argumentsJson: string,
    sessionId: number | null,
    workspace: string | null,
    needApproval: boolean,
    dangerReason: string | null,
  ): Promise<string> {
    if (!(await this.localToolSessionRegistry.isConnected(sessionId))) {
      return JSON.stringify({
        error: 'Local client is not connected. Please ensure the desktop app is running and connected.',
      });
    }
    const startResult = await this.localToolExecutor.execute(
      sessionId, 'shell', argumentsJson, workspace, needApproval, dangerReason,
    );
    const parsed = parseObject(startResult);
    if (!parsed || parsed.error || parsed.async !== true || typeof parsed.session_id !== 'string' || parsed.session_id.trim() === '') {
      return startResult;
    }
    const shellId = parsed.session_id;
    // 桌面端的 await_async 默认 yield 是它自己的值，必须把本次调用的等待语义透传过去
    const startArgs = parseObject(argumentsJson) ?? {};
    const awaitArgs: Record<string, unknown> = { action: 'await_async', session_id: shellId };
    if (startArgs.yield_time_ms != null) awaitArgs.yield_time_ms = startArgs.yield_time_ms;
    if (typeof startArgs.wait_for === 'string' && startArgs.wait_for !== '') awaitArgs.wait_for = startArgs.wait_for;
    const awaitArgsJson = JSON.stringify(awaitArgs);
    const taskId = this.backgroundTaskManager!.submit(sessionId, async () => {
      const awaited = await this.localToolExecutor.execute(
        sessionId, 'shell', awaitArgsJson, workspace, false, null,
      );
      // 桌面端返回的是结构化 JSON（exit_code/completed/output），原样交给后台任务管理器归一化
      return awaited;
    });
    return JSON.stringify({
      async: true,
      task_id: taskId,
      session_id: shellId,
      output_file: parsed.output_file ?? null,
      message: typeof parsed.message === 'string' ? parsed.message : '命令已提交到后台执行。',
    });
  }
}

function isLocalShellAsyncExec(argumentsJson: string): boolean {
  const args = parseObject(argumentsJson || '{}');
  if (!args || args.async !== true) return false;
  let action = typeof args.action === 'string' ? args.action : 'exec';
  if (action.trim() === '') action = 'exec';
  return action === 'exec';
}
