import { harnessLog } from '../log.js';
import type { LlmModelConfig } from '../llm/chat-request.js';
import type { SessionMapper, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import type { LocalToolExecutor } from '../local/local-tool-executor.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';
import type { DangerAssessor } from './danger-assessor.js';
import type { Tool } from './tool.js';
import { callTool } from './tool.js';
import type { ToolRegistry } from './tool-registry.js';
import { permissionLevelFromString, type PermissionLevel } from './permission-level.js';
import type { BackgroundTaskManager } from '../core/background-task-manager.js';
import { parseObject } from './json.js';

const ASK_USER_QUESTIONS = 'ask_user_questions';
const MCP_TOOL_PREFIX = 'mcp__';
const SERVER_ONLY_TOOLS = new Set([
  'task_create', 'task_update', 'task_list', 'task_delete',
  'spawn_subagent', 'subagent_followup', 'check_subagent', 'cancel_subagent', 'wait_subagents',
  'web_search', 'open_web_page', 'generate_image',
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
  dispatch(toolName: string, argumentsJson: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown, f?: unknown, g?: unknown): Promise<string> | string {
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
      return this.dispatchFull(toolName, argumentsJson, a as string, b as number, c as number, d as string, e as string, f as LlmModelConfig | null, null);
    }
    return this.dispatchFull(toolName, argumentsJson, a as string, b as number, c as number, d as string, e as string, f as LlmModelConfig | null, g as Tool[] | null);
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
  ): Promise<string> {
    if (toolName === ASK_USER_QUESTIONS) {
      return this.dispatchAskUserQuestions(argumentsJson, sessionId);
    }
    if (SERVER_ONLY_TOOLS.has(toolName)) {
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
      const decision = await this.shouldRequireApproval(toolName, level, argumentsJson, modelConfig);
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
      return await callTool(tool, argumentsJson, sessionId, userId, workspace);
    }
    throw new IllegalArgumentException('Unknown tool: ' + toolName);
  }

  private async dispatchAskUserQuestions(argumentsJson: string, sessionId: number | null): Promise<string> {
    let userId = sessionId != null ? await this.localToolSessionRegistry.getUserIdForSession(sessionId) : null;
    if (userId == null && sessionId != null) {
      const session = await this.sessionMapper.selectById(sessionId);
      if (session == null) return JSON.stringify({ error: `Session not found: ${sessionId}` });
      userId = session.userId ?? null;
    }
    if (userId == null || !this.streamingWsRegistry.hasConnection(userId)) {
      return JSON.stringify({ error: 'No connected client to receive questions' });
    }
    let questions: Array<Record<string, unknown>> = [];
    let metadata: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
      if (Array.isArray(parsed.questions)) {
        questions = parsed.questions.filter((q) => q && typeof q === 'object') as Array<Record<string, unknown>>;
      }
      if (parsed.metadata && typeof parsed.metadata === 'object') {
        metadata = parsed.metadata as Record<string, unknown>;
      }
    } catch (e) {
      harnessLog('warn', `Failed to parse ask_user_questions arguments: ${(e as Error).message}`);
    }
    const requestId = this.askUserQuestionsRegistry.register(sessionId!, questions, metadata);
    this.treeSignalPublisher.publishForSession(sessionId!);
    const data: Record<string, unknown> = { requestId, questions };
    if (metadata) data.metadata = metadata;
    this.streamingWsRegistry.send(userId, wsEvent('ask_user_questions', sessionId, data));
    const result = await this.askUserQuestionsRegistry.waitForAnswer(sessionId!, requestId);
    if (!result.answered || result.cancelled) {
      this.streamingWsRegistry.send(userId, wsEvent('ask_user_questions_cancelled', sessionId, { requestId }));
      this.treeSignalPublisher.publishForSession(sessionId!);
    }
    return result.resultJson;
  }

  private async shouldRequireApproval(
    toolName: string,
    level: PermissionLevel,
    argumentsJson: string,
    modelConfig: LlmModelConfig | null,
  ): Promise<{ needApproval: boolean; dangerReason: string | null }> {
    const isMcpTool = toolName != null && toolName.startsWith(MCP_TOOL_PREFIX);
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
        const result = await this.dangerAssessor.assess(argumentsJson, modelConfig);
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
    const taskId = this.backgroundTaskManager!.submit(sessionId, async () => {
      const awaited = await this.localToolExecutor.execute(
        sessionId, 'shell', JSON.stringify({ action: 'await_async', session_id: shellId }),
        workspace, false, null,
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
