import { randomUUID } from 'node:crypto';
import { nowSql } from '../../common/datetime.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import { harnessLog } from '../log.js';
import { boolish, llmModelToConfig, wsEvent } from '../deps.js';
import type {
  AgentMapper, AgentExperienceService, FileChangeMapper, LlmModel, LlmModelMapper,
  Session, SessionActivityHeartbeat, SessionCompactionService, SessionMapper, SessionService,
  StreamingWsRegistry, TaskTerminalService, ActivityService,
} from '../deps.js';
import type { AgentEventListener } from './agent-event-listener.js';
import { AgentLoop, type MessagePersistenceCallback, type ToolMessageSave } from './agent-loop.js';
import type { Db } from '../../db/db.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
import type { EnvironmentInfoProvider } from './environment-info-provider.js';
import type { LocalAgentsMdRegistry } from './local-agents-md-registry.js';
import type { PromptEngine } from './prompt-engine.js';
import type { SessionHistoryLoader } from './session-history-loader.js';
import type { SessionCompactionOrchestrator } from './session-compaction-orchestrator.js';
import { CompactionCancelledException, CompactionContextOverflowException } from './compaction-service.js';
import { CompactionStateReloadException } from './session-compaction-orchestrator.js';
import type { ActiveContextCalculator } from './active-context-calculator.js';
import type { ToolRegistry } from '../tool/tool-registry.js';
import type { Tool } from '../tool/tool.js';
import { isWeixinChannelTool } from '../tool/weixin-channel-tool.js';
import { FileChangeDiffUtil } from '../tool/file-change-diff-util.js';
import type { SkillLoader } from '../skill/skill-loader.js';
import type { SkillSyncService } from '../skill/skill-sync-service.js';
import type { LocalSkillRegistry } from '../skill/local-skill-registry.js';
import type { LocalSkillRef, SkillDocument } from '../skill/skill-document.js';
import type { McpClientManager } from '../mcp/mcp-client-manager.js';
import type { McpSyncService } from '../mcp/local/mcp-sync-service.js';
import { McpToolAdapter } from '../mcp/mcp-tool-adapter.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import { shanghaiYmd } from '../../common/json.js';
import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import type { ChatRequest, ChatUsage, ToolCall } from '../llm/chat-request.js';
import type { FileChange } from '../deps.js';

const ASK_USER_QUESTIONS = 'ask_user_questions';

export class HarnessService {
  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly toolRegistry: ToolRegistry,
    private readonly skillLoader: SkillLoader,
    private readonly skillSyncService: SkillSyncService,
    private readonly localSkillRegistry: LocalSkillRegistry,
    private readonly localAgentsMdRegistry: LocalAgentsMdRegistry,
    private readonly sessionMapper: SessionMapper,
    private readonly agentMapper: AgentMapper,
    private readonly experienceService: AgentExperienceService,
    private readonly llmModelMapper: LlmModelMapper,
    private readonly fileChangeMapper: FileChangeMapper,
    private readonly sessionService: SessionService,
    private readonly sessionCompactionService: SessionCompactionService,
    private readonly sessionHistoryLoader: SessionHistoryLoader,
    private readonly sessionCompactionOrchestrator: SessionCompactionOrchestrator,
    private readonly promptEngine: PromptEngine,
    private readonly activeContextCalculator: ActiveContextCalculator,
    private readonly compactionConfig: CompactionConfig,
    private readonly environmentInfoProvider: EnvironmentInfoProvider,
    private readonly db?: Db | null,
    private readonly mcpClientManager?: McpClientManager | null,
    private readonly mcpSyncService?: McpSyncService | null,
  ) {}

  prepareMessage(_sessionId: number, _userContent: unknown): string {
    return randomUUID();
  }

  async executeFromEvent(
    sessionId: number, _eventId: string, listener: AgentEventListener, cancelFlag?: AtomicBoolean | null,
  ): Promise<void> {
    await this.execute(sessionId, null, listener, cancelFlag);
  }

  async execute(
    sessionId: number, _userContent: string | null, listener: AgentEventListener, cancelFlag?: AtomicBoolean | null,
  ): Promise<void> {
    const context = await this.buildContext(sessionId, listener, cancelFlag);
    const persistenceCallback = this.createPersistenceCallback(sessionId, context);
    await this.agentLoop.execute(context, listener, persistenceCallback);
    if (cancelFlag != null) this.agentLoop.removeCancelFlag(sessionId);
  }

  createPersistenceCallback(targetSessionId: number, context: AgentExecutionContext): MessagePersistenceCallback {
    return {
      onSaveAssistantMessage: (
        content: string | null | undefined,
        thinkingContent: string | null | undefined,
        toolCalls: ToolCall[] | null | undefined,
        toolResultsOrUsage?: Record<string, string> | ChatUsage,
        usage?: ChatUsage,
      ) => {
        return this.persistAssistant(targetSessionId, context, content, thinkingContent, toolCalls, toolResultsOrUsage, usage);
      },
      onSaveToolMessage: (toolCallId: string, content: string, metadataJson?: string | null) => {
        return this.sessionService.saveMessage(targetSessionId, 'TOOL', content, null, toolCallId, null, 0, null, metadataJson).then(() => undefined);
      },
      onSaveToolRound: this.db ? (
        content, thinkingContent, toolCalls, toolMessages, toolResults, usage,
      ) => this.persistToolRound(
        targetSessionId, context, content, thinkingContent, toolCalls, toolMessages, toolResults, usage,
      ) : undefined,
    };
  }

  private async persistAssistant(
    targetSessionId: number,
    context: AgentExecutionContext,
    content: string | null | undefined,
    thinkingContent: string | null | undefined,
    toolCalls: ToolCall[] | null | undefined,
    toolResultsOrUsage?: Record<string, string> | ChatUsage,
    usage?: ChatUsage,
  ): Promise<void> {
    let toolResults: Record<string, string> = {};
    let resolvedUsage: ChatUsage | undefined = usage;
    if (toolResultsOrUsage && typeof toolResultsOrUsage === 'object' && 'promptTokens' in toolResultsOrUsage) {
      resolvedUsage = toolResultsOrUsage as ChatUsage;
    } else if (toolResultsOrUsage && typeof toolResultsOrUsage === 'object') {
      toolResults = toolResultsOrUsage as Record<string, string>;
    }
    let toolCallsJson: string | null = null;
    if (toolCalls && toolCalls.length > 0) {
      try {
        toolCallsJson = JSON.stringify(toolCalls);
      } catch (e) {
        harnessLog('warn', `Failed to serialize tool calls for session ${targetSessionId}`, e);
      }
    }
    const tokenCount = resolvedUsage?.totalTokens ?? 0;
    const modelId = context.modelConfig?.id ?? null;
    const savedMsg = toolCallsJson == null && this.db
      ? await this.persistFinalAssistant(targetSessionId, content, thinkingContent, tokenCount, modelId)
      : await this.sessionService.saveMessage(
        targetSessionId, 'ASSISTANT', content ?? null, thinkingContent, null, toolCallsJson, tokenCount, modelId);
    if (toolCalls && toolCalls.length > 0 && Object.keys(toolResults).length > 0) {
      await this.saveFileChanges(savedMsg.id!, targetSessionId, toolCalls, toolResults);
    }
  }

  private async persistFinalAssistant(
    targetSessionId: number,
    content: string | null | undefined,
    thinkingContent: string | null | undefined,
    tokenCount: number,
    modelId: number | null,
  ): Promise<{ id?: number }> {
    if (!this.db) throw new Error('Database is required for final assistant persistence');
    return this.db.transaction(async (tx) => {
      const id = await tx.insert('message', {
        sessionId: targetSessionId,
        role: 'ASSISTANT',
        content: content ?? null,
        thinkingContent: thinkingContent ?? null,
        toolCallId: null,
        toolCalls: null,
        tokenCount,
        modelId,
        metadata: null,
        sourceSessionId: null,
        deleted: 0,
      });
      await tx.execute(
        `UPDATE subagent_execution SET final_message_id = ?
         WHERE child_session_id = ? AND status IN ('RUNNING', 'RECOVERING')
         ORDER BY id DESC LIMIT 1`,
        [id, targetSessionId],
      );
      await tx.execute('UPDATE session SET updated_at = ? WHERE id = ?', [nowSql(), targetSessionId]);
      return { id };
    });
  }

  private async persistToolRound(
    targetSessionId: number,
    context: AgentExecutionContext,
    content: string | null | undefined,
    thinkingContent: string | null | undefined,
    toolCalls: ToolCall[],
    toolMessages: ToolMessageSave[],
    toolResults: Record<string, string>,
    usage?: ChatUsage,
  ): Promise<void> {
    if (!this.db) throw new Error('Database is required for tool round persistence');
    const toolCallsJson = JSON.stringify(toolCalls);
    const toolCallIds = toolCalls.map((call) => call.id).filter((id): id is string => Boolean(id));
    const assistantId = await this.db.transaction(async (tx) => {
      const id = await tx.insert('message', {
        sessionId: targetSessionId,
        role: 'ASSISTANT',
        content: content ?? null,
        thinkingContent: thinkingContent ?? null,
        toolCallId: null,
        toolCalls: toolCallsJson,
        tokenCount: usage?.totalTokens ?? 0,
        modelId: context.modelConfig?.id ?? null,
        metadata: null,
        sourceSessionId: null,
        deleted: 0,
      });
      const toolMessageIds = new Map<string, number>();
      for (const tool of toolMessages) {
        toolMessageIds.set(tool.toolCallId, await tx.insert('message', {
          sessionId: targetSessionId,
          role: 'TOOL',
          content: tool.content,
          thinkingContent: null,
          toolCallId: tool.toolCallId,
          toolCalls: null,
          tokenCount: 0,
          modelId: null,
          metadata: tool.metadataJson,
          sourceSessionId: null,
          deleted: 0,
        }));
      }
      if (toolCallIds.length > 0) {
        const placeholders = toolCallIds.map(() => '?').join(',');
        const rows = await tx.query<{ id: number; parentToolCallId: string }>(
          `SELECT id, parent_tool_call_id FROM subagent_execution
           WHERE parent_session_id = ? AND delivery_status = 'PENDING'
             AND invocation_type = 'DELEGATE'
             AND parent_tool_call_id IN (${placeholders}) FOR UPDATE`,
          [targetSessionId, ...toolCallIds],
        );
        const now = nowSql();
        for (const execution of rows) {
          const toolMessageId = toolMessageIds.get(execution.parentToolCallId);
          if (toolMessageId == null) continue;
          await tx.execute(
            `UPDATE subagent_execution SET delivery_status = 'DELIVERED',
             parent_result_delivered_at = ?, parent_assistant_message_id = ?, parent_tool_message_id = ?
             WHERE id = ? AND delivery_status = 'PENDING' AND invocation_type = 'DELEGATE'`,
            [now, id, toolMessageId, execution.id],
          );
        }
      }
      await tx.execute('UPDATE session SET updated_at = ? WHERE id = ?', [nowSql(), targetSessionId]);
      return id;
    });
    if (Object.keys(toolResults).length > 0) {
      await this.saveFileChanges(assistantId, targetSessionId, toolCalls, toolResults);
    }
  }

  async executePrepared(context: AgentExecutionContext, listener: AgentEventListener): Promise<void> {
    const persistence = this.createPersistenceCallback(context.sessionId!, context);
    await this.agentLoop.execute(context, listener, persistence);
  }

  async buildContext(
    sessionId: number, listener?: AgentEventListener | null, cancelFlag?: AtomicBoolean | null,
  ): Promise<AgentExecutionContext> {
    const session = await this.sessionMapper.selectById(sessionId);
    if (session == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    const agent = await this.agentMapper.selectById(session.agentId!);
    if (agent == null) throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    const llmModel = await this.resolveModel(session.modelId ?? null);
    if (llmModel == null) throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);

    const executionMode = session.executionMode ?? 'CLOUD';
    if (executionMode.toUpperCase() === 'CLOUD') {
      try {
        await this.skillSyncService.syncToSession(agent, session.userId ?? null, sessionId);
      } catch (e) {
        harnessLog('warn', `Skill sync to session runtime failed for session ${sessionId}: ${(e as Error).message}`);
      }
    }

    const context = new AgentExecutionContext();
    context.cancelFlag = cancelFlag;
    context.currentTimestamp = shanghaiYmd();
    context.sessionId = sessionId;
    context.userId = session.userId;
    context.agentId = agent.id;
    context.projectKey = session.projectKey;
    context.systemPrompt = agent.systemPrompt;
    context.experiences = await this.experienceService.listEnabledContents(agent.id!);
    context.agentName = agent.name;
    context.executionMode = executionMode;
    context.permissionLevel = session.permissionLevel;
    context.workspace = session.workspace;
    const environmentInfo = await this.environmentInfoProvider.fromSessionOrDetect(session);
    context.isGit = environmentInfo.isGit;
    context.platform = environmentInfo.platform;
    context.shellPath = environmentInfo.shell;
    context.osVersion = environmentInfo.osVersion;
    context.modelConfig = llmModelToConfig(llmModel);
    context.modelConfig.supportsVision = boolish(llmModel.supportsVision) === true;

    const effectiveConfig = this.resolveCompactionConfig(agent);
    context.compactionConfig = effectiveConfig;
    const compactionRecord = await this.sessionCompactionService.loadValidated(sessionId);
    const boundary = this.sessionCompactionService.boundaryOf(compactionRecord);
    const summary = compactionRecord?.summaryText ?? null;
    if (this.sessionService.cleanupIncompleteTailAfterId) {
      await this.sessionService.cleanupIncompleteTailAfterId(sessionId, boundary);
    }
    const history = await this.sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, boundary);
    this.sessionHistoryLoader.applyHistory(context, summary, history);

    const anchor = await this.sessionService.loadContextAnchor(sessionId);
    context.lastPromptTokens = anchor.lastPromptTokens;
    context.contextAnchorMsgId = anchor.contextAnchorMsgId;

    let sessionTools = HarnessService.filterToolsForSession(this.toolRegistry.getAllTools(), session.projectKey);
    const mcpWarnings: string[] = [];
    if (this.mcpSyncService) {
      try {
        const mcpServers = await this.mcpSyncService.loadAgentServers(agent, session.userId ?? null);
        if (mcpServers.length > 0) {
          if (executionMode.toUpperCase() === 'LOCAL') {
            const localTools = this.mcpSyncService.getLocalSessionTools(sessionId);
            for (const ref of localTools) {
              sessionTools.push(new McpToolAdapter(ref, this.mcpClientManager ?? null));
            }
          } else if (this.mcpClientManager) {
            const cloudResult = await this.mcpSyncService.connectForCloud(sessionId, mcpServers, this.mcpClientManager);
            for (const ref of cloudResult.tools) {
              sessionTools.push(new McpToolAdapter(ref, this.mcpClientManager));
            }
            mcpWarnings.push(...cloudResult.warnings);
          } else {
            harnessLog('warn', `MCP client manager unavailable for session ${sessionId}, skipping CLOUD MCP injection`);
          }
        }
      } catch (e) {
        harnessLog('warn', `MCP tool injection failed for session ${sessionId}: ${(e as Error).message}`);
        mcpWarnings.push('MCP 工具加载失败：' + (e as Error).message);
      }
    }
    context.tools = sessionTools;

    let agentSkillNames: string[] | null = null;
    const skillNamesJson = agent.skillNames ?? agent.skills;
    if (hasText(skillNamesJson)) {
      try {
        agentSkillNames = JSON.parse(skillNamesJson!) as string[];
      } catch (e) {
        harnessLog('warn', `Failed to parse skillNames for agent ${agent.id}: ${(e as Error).message}`);
      }
    }
    const userSkillNames = this.skillSyncService.getUserSkillNames(session.userId ?? 0);
    const syncableNames = new Set<string>(userSkillNames);
    const mergedSkillNames: string[] = [];
    if (agentSkillNames != null) {
      for (const name of agentSkillNames) {
        if (this.skillLoader.hasSkill(name)) {
          syncableNames.add(name);
          mergedSkillNames.push(name);
        }
      }
    }
    for (const userSkill of userSkillNames) {
      if (!mergedSkillNames.includes(userSkill)) mergedSkillNames.push(userSkill);
    }
    if (context.executionMode?.toUpperCase() === 'LOCAL') {
      HarnessService.mergeLocalUnsyncedSkills(
        mergedSkillNames, syncableNames, this.localSkillRegistry.get(sessionId), context);
      context.agentsMdContent = this.localAgentsMdRegistry.get(sessionId);
    }
    context.availableSkillNames = mergedSkillNames;

    const skillDocMap = new Map<string, SkillDocument>();
    for (const doc of this.skillLoader.getAllDocuments()) skillDocMap.set(doc.name, doc);
    for (const doc of this.skillSyncService.getUserSkillDocuments(session.userId ?? 0)) {
      skillDocMap.set(doc.name, doc);
    }
    for (const ref of context.localUnsyncedSkills) {
      if (!skillDocMap.has(ref.name)) {
        skillDocMap.set(ref.name, { name: ref.name, description: ref.description });
      }
    }
    context.availableSkillDocs = skillDocMap;

    if (mcpWarnings.length > 0) {
      context.addSystemMessage('⚠ ' + mcpWarnings.join('；')
        + '。相关 MCP 工具不可用，请勿调用；如需恢复请检查服务器配置后新开会话。');
    }

    if (effectiveConfig.enabled && history.persistedMessages.length > 0) {
      const normalRequest = await this.buildNormalRequest(context);
      try {
        await this.sessionCompactionOrchestrator.compact(
          sessionId, context, normalRequest, listener ?? null, effectiveConfig, false, cancelFlag ?? null);
        context.preparedRequest = await this.buildNormalRequest(context);
      } catch (e) {
        if (e instanceof CompactionContextOverflowException
          || e instanceof CompactionCancelledException
          || e instanceof CompactionStateReloadException) {
          throw e;
        }
        context.preparedRequest = await this.buildNormalRequest(context);
        harnessLog('warn', 'Session compaction failed; continuing with a request rebuilt from current context', e);
      }
    } else {
      context.preparedRequest = await this.buildNormalRequest(context);
    }
    return context;
  }

  private buildNormalRequest(context: AgentExecutionContext): Promise<ChatRequest> {
    return this.promptEngine.buildRequest(context);
  }

  static filterToolsForSession(tools: Tool[], projectKey: string | null | undefined): Tool[] {
    const result = [...tools];
    if (projectKey === WEIXIN_PROJECT_KEY) {
      return result.filter((t) => t.getName() !== ASK_USER_QUESTIONS);
    }
    return result.filter((t) => !isWeixinChannelTool(t));
  }

  static mergeLocalUnsyncedSkills(
    mergedSkillNames: string[],
    syncableNames: Set<string>,
    localSkills: LocalSkillRef[] | null | undefined,
    context: AgentExecutionContext,
  ): void {
    if (!localSkills || localSkills.length === 0) return;
    const unsynced: LocalSkillRef[] = [];
    for (const ref of localSkills) {
      if (!ref?.name || ref.name.trim() === '') continue;
      if (!syncableNames.has(ref.name)) {
        if (!mergedSkillNames.includes(ref.name)) mergedSkillNames.push(ref.name);
        unsynced.push(ref);
      }
    }
    context.localUnsyncedSkills = unsynced;
  }

  private resolveCompactionConfig(agent: { configJson?: string | null }): CompactionConfig {
    if (!hasText(agent.configJson)) return this.compactionConfig;
    try {
      const node = JSON.parse(agent.configJson!) as Record<string, unknown>;
      const compactionNode = node.compaction as Record<string, unknown> | undefined;
      if (!compactionNode) return this.compactionConfig;
      const merged = new CompactionConfig();
      merged.enabled = this.compactionConfig.enabled;
      merged.contextWindowTokens = this.compactionConfig.contextWindowTokens;
      merged.triggerRatio = this.compactionConfig.triggerRatio;
      merged.maxSummaryTokens = this.compactionConfig.maxSummaryTokens;
      merged.loopMidwayCompact = this.compactionConfig.loopMidwayCompact;
      if (compactionNode.enabled != null) merged.enabled = Boolean(compactionNode.enabled);
      if (compactionNode.contextWindowTokens != null) merged.contextWindowTokens = Number(compactionNode.contextWindowTokens);
      if (compactionNode.triggerRatio != null) merged.triggerRatio = Number(compactionNode.triggerRatio);
      if (compactionNode.maxSummaryTokens != null) merged.maxSummaryTokens = Number(compactionNode.maxSummaryTokens);
      if (compactionNode.loopMidwayCompact != null) merged.loopMidwayCompact = Boolean(compactionNode.loopMidwayCompact);
      return merged;
    } catch (e) {
      harnessLog('warn', 'Failed to parse agent compaction config, using defaults', e);
      return this.compactionConfig;
    }
  }

  private async saveFileChanges(
    messageId: number, sessionId: number, toolCalls: ToolCall[], toolResults: Record<string, string>,
  ): Promise<void> {
    const merged = new Map<string, FileChange>();
    for (const tc of toolCalls) {
      const toolName = tc.function?.name;
      if (toolName !== 'write_file' && toolName !== 'edit_file') continue;
      const result = toolResults[tc.id!];
      if (result == null) continue;
      try {
        const resultNode = JSON.parse(result) as Record<string, unknown>;
        if (!resultNode.file_change || resultNode.success !== true) continue;
        const fc = resultNode.file_change as Record<string, unknown>;
        const p = String(fc.path);
        const diff = resultNode[FileChangeDiffUtil.PRIVATE_DIFF_FIELD] as Record<string, unknown> | undefined;
        const existing = merged.get(p);
        if (existing) {
          existing.linesAdded = (existing.linesAdded ?? 0) + Number(fc.lines_added ?? 0);
          existing.linesDeleted = (existing.linesDeleted ?? 0) + Number(fc.lines_deleted ?? 0);
          if (fc.type === 'CREATED') existing.type = 'CREATED';
          mergeDiffPayload(existing, diff);
        } else {
          const change: FileChange = {
            messageId, sessionId, path: p, type: String(fc.type),
            linesAdded: Number(fc.lines_added ?? 0),
            linesDeleted: Number(fc.lines_deleted ?? 0),
          };
          applyDiffPayload(change, diff);
          merged.set(p, change);
        }
      } catch (e) {
        harnessLog('debug', `Failed to parse file_change from tool result for tool ${toolName}`, e);
      }
    }
    for (const fc of merged.values()) {
      try {
        await this.fileChangeMapper.insert(fc);
      } catch (e) {
        harnessLog('warn', `Failed to save file change record for ${fc.path}`, e);
      }
    }
  }

  async executeSideFirstMessage(
    parentSessionId: number,
    sideSessionId: number,
    inheritContext: boolean,
    listener: AgentEventListener,
    cancelFlag?: AtomicBoolean | null,
  ): Promise<void> {
    const context = await this.buildContext(sideSessionId, listener, cancelFlag);
    if (inheritContext) {
      const contextSummary = await this.generateContextSummary(parentSessionId);
      if (hasText(contextSummary)) {
        context.systemPrompt = (context.systemPrompt ?? '')
          + '\n\n<主任务背景摘要>\n' + contextSummary + '\n</主任务背景摘要>\n'
          + '以上是主任务的最近对话摘要，本次边路任务的结果不需要反馈到主任务。';
        context.preparedRequest = null;
      }
    }
    const persistenceCallback = this.createPersistenceCallback(sideSessionId, context);
    await this.agentLoop.execute(context, listener, persistenceCallback);
    if (cancelFlag != null) this.agentLoop.removeCancelFlag(sideSessionId);
  }

  private async generateContextSummary(parentSessionId: number): Promise<string | null> {
    try {
      const messages = this.sessionService.getMessages
        ? await this.sessionService.getMessages(parentSessionId) : [];
      if (messages.length === 0) return null;
      const fromIndex = Math.max(0, messages.length - 10);
      const recent = messages.slice(fromIndex);
      let sb = '以下是主任务最近的对话摘要：\n\n';
      for (const msg of recent) {
        const content = msg.content;
        if (hasText(content)) {
          const truncated = content!.length > 300 ? content!.slice(0, 300) + '...' : content!;
          sb += `[${msg.role}]: ${truncated}\n`;
        }
      }
      return sb;
    } catch (e) {
      harnessLog('warn', 'Failed to generate context summary for side task', e);
      return null;
    }
  }

  async resolveModel(modelId: number | null): Promise<LlmModel | null> {
    if (modelId != null) return this.llmModelMapper.selectById(modelId);
    return this.llmModelMapper.selectDefault ? this.llmModelMapper.selectDefault() : null;
  }
}

function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim().length > 0;
}

function applyDiffPayload(change: FileChange, diff: Record<string, unknown> | null | undefined): void {
  if (!diff || typeof diff !== 'object') return;
  change.diffMode = textOrNull(diff, 'diff_mode');
  change.beforeContent = textOrNull(diff, 'before_content');
  change.afterContent = textOrNull(diff, 'after_content');
  change.patchContent = textOrNull(diff, 'patch_content');
  change.patchTruncated = booleanOrFalse(diff, 'patch_truncated');
  change.diffUnavailableReason = textOrNull(diff, 'diff_unavailable_reason');
}

function mergeDiffPayload(existing: FileChange, diff: Record<string, unknown> | null | undefined): void {
  if (!diff || typeof diff !== 'object') return;
  const mode = textOrNull(diff, 'diff_mode');
  if (mode == null) return;
  if (existing.diffMode == null) {
    applyDiffPayload(existing, diff);
    return;
  }
  if (existing.diffMode === 'SNAPSHOT' && mode === 'SNAPSHOT') {
    const after = textOrNull(diff, 'after_content');
    if (after != null) existing.afterContent = after;
    existing.patchTruncated = existing.patchTruncated === true || booleanOrFalse(diff, 'patch_truncated');
    return;
  }
  if (existing.diffMode === 'PATCH' || mode === 'PATCH') {
    existing.diffMode = 'PATCH';
    let patch = textOrNull(diff, 'patch_content');
    if (patch == null && mode === 'SNAPSHOT') patch = '[snapshot diff omitted after patch-mode aggregation]\n';
    let current = existing.patchContent ?? null;
    if (current == null && existing.beforeContent != null && existing.afterContent != null) {
      current = '[snapshot diff omitted before patch-mode aggregation]\n';
    }
    existing.patchContent = joinPatch(current, patch);
    existing.beforeContent = null;
    existing.afterContent = null;
    existing.patchTruncated = existing.patchTruncated === true || booleanOrFalse(diff, 'patch_truncated');
    return;
  }
  if (mode === 'UNSUPPORTED') {
    existing.diffMode = 'UNSUPPORTED';
    existing.beforeContent = null;
    existing.afterContent = null;
    existing.patchContent = null;
    existing.patchTruncated = false;
    existing.diffUnavailableReason = textOrNull(diff, 'diff_unavailable_reason');
  }
}

function joinPatch(current: string | null | undefined, patch: string | null | undefined): string | null | undefined {
  if (!hasText(current)) return patch;
  if (!hasText(patch)) return current;
  return current + '\n' + patch;
}

function textOrNull(node: Record<string, unknown>, field: string): string | null {
  const value = node[field];
  return value == null ? null : String(value);
}

function booleanOrFalse(node: Record<string, unknown>, field: string): boolean {
  return node[field] === true;
}
