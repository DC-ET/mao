import type { ChatMessage, ChatRequest, ChatUsage, LlmAdapter, StreamCallback, StreamChunk, ToolCall } from '../llm/chat-request.js';
import { EmptyResponseExhaustedException } from '../llm/empty-response-exhausted.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import { harnessLog } from '../log.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { AgentExecutionContext } from './agent-execution-context.js';
import type { ActiveContextCalculator } from './active-context-calculator.js';
import type { BackgroundTaskManager } from './background-task-manager.js';
import type { BackgroundSubagentManager } from '../delegate/background-subagent-manager.js';
import { CompactionConfig } from './compaction-config.js';
import { CompactionCancelledException, CompactionContextOverflowException } from './compaction-service.js';
import type { ContextManager } from './context-manager.js';
import type { PromptEngine } from './prompt-engine.js';
import type { SessionCompactionOrchestrator } from './session-compaction-orchestrator.js';
import { CompactionStateReloadException } from './session-compaction-orchestrator.js';
import type { SessionActivityHeartbeat, SessionService } from '../deps.js';
import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { FileChangeDiffUtil } from '../tool/file-change-diff-util.js';
import { ToolCallContext } from '../tool/tool-call-context.js';
import type { ToolDispatcher } from '../tool/tool-dispatcher.js';
import { ToolImageResultProcessor } from '../tool/tool-image-result-processor.js';
import { ToolResultSummarizer } from '../../session/util/tool-result-summarizer.js';
import type { Tool } from '../tool/tool.js';
import type { ShellSessionManager } from '../shell/shell-session-manager.js';
import type { McpClientManager } from '../mcp/mcp-client-manager.js';

export interface MessagePersistenceCallback {
  onSaveAssistantMessage(
    content: string | null | undefined,
    thinkingContent: string | null | undefined,
    toolCalls: ToolCall[] | null | undefined,
    usageOrResults?: ChatUsage | Record<string, string>,
    usage?: ChatUsage,
  ): void | Promise<void>;
  onSaveToolMessage(toolCallId: string, content: string, metadataJson?: string | null): void | Promise<void>;
  onSaveToolRound?(
    content: string | null | undefined,
    thinkingContent: string | null | undefined,
    toolCalls: ToolCall[],
    toolMessages: ToolMessageSave[],
    toolResults: Record<string, string>,
    usage?: ChatUsage,
  ): void | Promise<void>;
}

export interface ToolMessageSave {
  toolCallId: string;
  content: string;
  metadataJson: string | null;
}

export class AgentLoop {
  private readonly cancelFlags = new Map<number, AtomicBoolean>();

  constructor(
    private readonly llmAdapter: LlmAdapter,
    private readonly promptEngine: PromptEngine,
    private readonly contextManager: ContextManager,
    private readonly toolDispatcher: ToolDispatcher,
    private readonly backgroundTaskManager: BackgroundTaskManager,
    private readonly shellSessionManager: ShellSessionManager,
    private readonly activityHeartbeat: SessionActivityHeartbeat,
    private readonly sessionService: SessionService,
    private readonly sessionCompactionOrchestrator: SessionCompactionOrchestrator,
    private readonly activeContextCalculator: ActiveContextCalculator,
    private readonly mcpClientManager: McpClientManager,
    private readonly backgroundSubagentManager?: (() => BackgroundSubagentManager | null | undefined) | null,
  ) {}

  registerCancelFlag(sessionId: number): AtomicBoolean {
    const flag = new AtomicBoolean(false);
    this.cancelFlags.set(sessionId, flag);
    return flag;
  }

  getCancelFlag(sessionId: number | null | undefined): AtomicBoolean | undefined {
    return sessionId != null ? this.cancelFlags.get(sessionId) : undefined;
  }

  requestCancel(sessionId: number): void {
    this.getCancelFlag(sessionId)?.set(true);
  }

  removeCancelFlag(sessionId: number): void {
    this.cancelFlags.delete(sessionId);
  }

  private async isCancelled(context: AgentExecutionContext): Promise<boolean> {
    if (context.cancelFlag?.get()) return true;
    const sessionId = context.sessionId;
    if (sessionId != null) {
      const flag = this.cancelFlags.get(sessionId);
      if (flag?.get()) return true;
      if (await this.isTerminalPhaseInDb(sessionId)) {
        const f = flag ?? new AtomicBoolean(false);
        if (!flag) this.cancelFlags.set(sessionId, f);
        f.set(true);
        return true;
      }
    }
    return false;
  }

  private async isTerminalPhaseInDb(sessionId: number): Promise<boolean> {
    try {
      const session = await this.sessionService.getSession(sessionId);
      const phase = session?.phase;
      return phase === 'FAILED' || phase === 'CANCELLED';
    } catch (e) {
      if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) {
        return true;
      }
      return false;
    }
  }

  private resolveCancelFlag(context: AgentExecutionContext): AtomicBoolean | undefined {
    const sessionFlag = context.sessionId != null ? this.cancelFlags.get(context.sessionId) : undefined;
    const inherited = context.cancelFlag ?? undefined;
    if (sessionFlag) {
      if (inherited?.get()) sessionFlag.set(true);
      return sessionFlag;
    }
    return inherited;
  }

  private async sleepMs(ms: number, cancelFlag?: { get(): boolean } | null): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cancelFlag?.get()) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  }

  async execute(
    context: AgentExecutionContext,
    listener: AgentEventListener,
    persistenceCallback?: MessagePersistenceCallback | null,
  ): Promise<void> {
    let round = 0;
    let emptyResponseCount = 0;
    try {
      let pendingSave: string | null = null;
      let pendingThinking: string | null = null;
      let pendingSaveUsage: ChatUsage | null = null;
      let pendingSaveToolCalls: ToolCall[] | null = null;

      await this.ensureContextAnchorLoaded(context);

      while (true) {
        round++;
        context.currentRound = round;
        listener.onRoundStart?.(round);
        const sessionId = context.sessionId;
        this.activityHeartbeat.touch(sessionId);
        const cancelFlag = this.resolveCancelFlag(context);
        if (await this.isCancelled(context)) {
          cancelFlag?.set(true);
          return;
        }

        const bgResults = await Promise.resolve(this.backgroundTaskManager.consumeCompletedResults(sessionId ?? null));
        if (Object.keys(bgResults).length > 0) {
          let sb = '<后台任务结果>\n';
          for (const [taskId, result] of Object.entries(bgResults)) {
            sb += `任务 ${taskId}：${result}\n`;
          }
          sb += '</后台任务结果>';
          context.addSystemMessage(sb);
          context.preparedRequest = null;
        }

        const bgSubagentManager = this.backgroundSubagentManager?.();
        const bgSubagentResults = bgSubagentManager
          ? await bgSubagentManager.consumeResults(sessionId ?? null)
          : {};
        if (Object.keys(bgSubagentResults).length > 0) {
          let sb = '<后台子代理结果>\n';
          for (const [taskId, result] of Object.entries(bgSubagentResults)) {
            sb += `任务 ${taskId}：${result}\n`;
          }
          sb += '</后台子代理结果>';
          context.addSystemMessage(sb);
          // 结果已注入，必须丢弃可能由上一轮 mid-loop compaction 预构建的请求，
          // 否则本轮会命中旧请求而忽略刚注入的后台结果。
          context.preparedRequest = null;
        }

        const request = context.preparedRequest ?? await this.promptEngine.buildRequest(context);
        context.preparedRequest = null;

        const preRequestMaxMsgId = context.sessionId != null
          ? await this.sessionService.getMaxMessageId(context.sessionId) : 0;
        const messagesCoveredThisRound = context.messages.length;
        const estimatedTokens = this.computeActiveTokens(context, request);
        listener.onContextWindow?.(estimatedTokens, context.lastPromptTokens > 0 ? context.lastPromptTokens : 0);

        const currentRound = round;
        let emptyResponseEncountered = false;
        const emptyBackoffMs = { v: 0 };
        const emptyRetryInfo = { attempt: 0, maxRetries: 10 };
        const thinkingEnded = { v: false };
        const emittedEarlyStarts = new Set<string>();
        listener.onThinkingStart?.();
        try {
          const contentBuilder: string[] = [];
          const thinkingBuilder: string[] = [];
          const toolCalls: ToolCall[] = [];

          const afterStream: Promise<unknown>[] = [];
          const callback: StreamCallback = {
            onChunk: (chunk: StreamChunk) => {
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) return;
              if (delta.reasoningContent) {
                thinkingBuilder.push(delta.reasoningContent);
                listener.onThinkingDelta?.(delta.reasoningContent);
              }
              if (delta.content) {
                if (!thinkingEnded.v) {
                  thinkingEnded.v = true;
                  listener.onThinkingEnd?.();
                }
                contentBuilder.push(delta.content);
                listener.onContentDelta(delta.content);
              }
              if (delta.toolCalls) {
                for (const tc of delta.toolCalls) {
                  const merged = this.mergeToolCall(toolCalls, tc, listener, emittedEarlyStarts);
                  if (merged?.id && merged.function) {
                    listener.onToolCallArgsDelta?.(merged.id, merged.function.arguments ?? '');
                  }
                }
              }
            },
            onComplete: (usage: ChatUsage) => {
              if (!thinkingEnded.v) {
                thinkingEnded.v = true;
                listener.onThinkingEnd?.();
              }
              context.addUsage(usage);
              if (usage && usage.promptTokens > 0) {
                const promptTokens = usage.promptTokens;
                const anchorMsgId = preRequestMaxMsgId > 0 ? preRequestMaxMsgId : context.contextAnchorMsgId;
                context.lastPromptTokens = promptTokens;
                context.contextAnchorMsgId = anchorMsgId;
                context.messagesCoveredByAnchor = messagesCoveredThisRound;
                if (context.sessionId != null && anchorMsgId > 0) {
                  afterStream.push(this.sessionService.updateContextAnchor(context.sessionId, promptTokens, anchorMsgId));
                }
                listener.onContextWindow?.(promptTokens, promptTokens);
              }
              if (toolCalls.length > 0) {
                for (const tc of toolCalls) {
                  // 与 Java 版一致：流结束时用完整参数刷新监听器缓存。
                  // 监听器会去重 start 事件，但摘要器随后需要这里的最终 arguments。
                  listener.onToolCallStart(tc);
                }
                context.pendingToolCalls = toolCalls;
              }
              const content = contentBuilder.join('');
              const thinkingContent = thinkingBuilder.length > 0 ? thinkingBuilder.join('') : null;
              if (content !== '' || toolCalls.length > 0) {
                // 收到有效输出即复位计数，保证"连续 10 次空响应"语义
                emptyResponseCount = 0;
                context.addAssistantMessage(content, toolCalls, thinkingContent);
                if (toolCalls.length === 0 && persistenceCallback) {
                  afterStream.push(Promise.resolve(persistenceCallback.onSaveAssistantMessage(content, thinkingContent, toolCalls, usage)));
                } else {
                  pendingSave = content;
                  pendingThinking = thinkingContent;
                  pendingSaveUsage = usage;
                  pendingSaveToolCalls = toolCalls;
                }
              } else {
                // LLM 返回了空响应（无 content、无 tool_calls，可能有思考或无思考）。
                // 指数退避重试，最多 10 次。
                emptyResponseCount++;
                const emptyMaxRetries = 10;
                const backoffSeconds = Math.min(30, Math.pow(2, emptyResponseCount - 1));
                emptyBackoffMs.v = backoffSeconds * 1000;
                emptyRetryInfo.attempt = emptyResponseCount;
                emptyRetryInfo.maxRetries = emptyMaxRetries;
                harnessLog('warn',
                  `Agent loop round ${currentRound} for session ${sessionId}: empty LLM response`
                  + ` (thinking=${thinkingContent?.length ?? 0} chars, retry=${emptyResponseCount}/${emptyMaxRetries})`,
                );
                if (emptyResponseCount >= emptyMaxRetries) {
                  // 专用异常类型：适配器须原样透传，不得包装成流中断或触发整轮流重试
                  throw new EmptyResponseExhaustedException();
                }
                emptyResponseEncountered = true;
              }
            },
            onError: (t: unknown) => {
              harnessLog('error', 'LLM call failed', t);
              throw new Error('LLM call failed: ' + (t as Error).message, { cause: t });
            },
            onStreamReset: () => {
              contentBuilder.length = 0;
              thinkingBuilder.length = 0;
              toolCalls.length = 0;
              emittedEarlyStarts.clear();
              thinkingEnded.v = false;
              listener.onLlmStreamReset?.();
            },
            onWaiting: (phase, elapsed) => listener.onLlmWaiting?.(phase, elapsed),
            onRetry: (reason, statusCode, attempt, maxRetries, delaySeconds) => {
              listener.onLlmRetry?.(reason, statusCode, attempt, maxRetries, delaySeconds);
            },
          };

          await this.llmAdapter.stream(request, context.modelConfig!, callback, cancelFlag ?? null);
          await Promise.all(afterStream);
        } catch (e) {
          if (!thinkingEnded.v) {
            thinkingEnded.v = true;
            listener.onThinkingEnd?.();
          }
          if (e instanceof Error && e.message.includes('Cancelled by user')) {
            harnessLog('info', `Agent loop round ${currentRound} cancelled by user for session ${sessionId}`);
            break;
          }
          throw e;
        }

        const pendingCalls = context.pendingToolCalls;
        if (!pendingCalls || pendingCalls.length === 0) {
          if (emptyResponseEncountered) {
            // 空响应：指数退避后重试下一轮，通知客户端重试事件
            const backoffSeconds = Math.ceil(emptyBackoffMs.v / 1000);
            listener.onLlmRetry?.('empty_response', null, emptyRetryInfo.attempt, emptyRetryInfo.maxRetries, backoffSeconds);
            if (emptyBackoffMs.v > 0) {
              await this.sleepMs(emptyBackoffMs.v, cancelFlag ?? null);
            }
            context.clearPendingToolCalls();
            continue;
          }
          const bgSubagentManager = this.backgroundSubagentManager?.();
          if (bgSubagentManager?.hasRunning(sessionId ?? null) || bgSubagentManager?.hasPendingResults(sessionId ?? null)) {
            await bgSubagentManager.waitForAll(sessionId ?? null, cancelFlag ?? null);
            if (await this.isCancelled(context)) {
              cancelFlag?.set(true);
              return;
            }
            context.clearPendingToolCalls();
            continue;
          }
          listener.onRoundEnd?.(round);
          break;
        }

        const toolResults: Record<string, string> = {};
        const pendingToolSaves: ToolMessageSave[] = [];
        await this.executeToolCalls(pendingCalls, context, listener, pendingToolSaves, toolResults, cancelFlag ?? null);
        this.activityHeartbeat.touch(context.sessionId);

        if (await this.isCancelled(context)) {
          cancelFlag?.set(true);
          this.rollbackIncompleteRound(context, pendingSaveToolCalls);
          pendingSave = null;
          pendingThinking = null;
          pendingSaveUsage = null;
          pendingSaveToolCalls = null;
          context.clearPendingToolCalls();
          break;
        }

        if (pendingSaveToolCalls && persistenceCallback) {
          if (persistenceCallback.onSaveToolRound) {
            await Promise.resolve(persistenceCallback.onSaveToolRound(
              pendingSave, pendingThinking, pendingSaveToolCalls, pendingToolSaves,
              toolResults, pendingSaveUsage ?? undefined,
            ));
          } else {
            await Promise.resolve(persistenceCallback.onSaveAssistantMessage(
              pendingSave, pendingThinking, pendingSaveToolCalls, toolResults, pendingSaveUsage ?? undefined,
            ));
            for (const toolSave of pendingToolSaves) {
              await Promise.resolve(persistenceCallback.onSaveToolMessage(
                toolSave.toolCallId, toolSave.content, toolSave.metadataJson,
              ));
            }
          }
          pendingSave = null;
          pendingThinking = null;
          pendingSaveUsage = null;
          pendingSaveToolCalls = null;
        } else if (pendingToolSaves.length > 0 && persistenceCallback) {
          for (const toolSave of pendingToolSaves) {
            await Promise.resolve(persistenceCallback.onSaveToolMessage(
              toolSave.toolCallId, toolSave.content, toolSave.metadataJson,
            ));
          }
        }

        context.clearPendingToolCalls();
        listener.onRoundEnd?.(round);

        const loopConfig = context.compactionConfig;
        const midLoopAllowed = loopConfig != null
          && loopConfig.enabled && loopConfig.loopMidwayCompact
          && persistenceCallback != null
          && context.sessionId != null;
        if (midLoopAllowed && loopConfig) {
          try {
            const nextRequest = await this.promptEngine.buildRequest(context);
            const nextRequestTokens = this.computeActiveTokens(context, nextRequest);
            listener.onContextWindow?.(nextRequestTokens, context.lastPromptTokens > 0 ? context.lastPromptTokens : 0);
            const effectiveContextWindow = CompactionConfig.resolveEffectiveContextWindow(context.modelConfig, loopConfig);
            if (nextRequestTokens >= effectiveContextWindow * loopConfig.triggerRatio) {
              await this.sessionCompactionOrchestrator.compact(
                context.sessionId!, context, nextRequest, listener, loopConfig, true, cancelFlag ?? null, nextRequestTokens);
              context.preparedRequest = await this.promptEngine.buildRequest(context);
            }
          } catch (e) {
            if (e instanceof CompactionContextOverflowException || e instanceof CompactionStateReloadException) throw e;
            if (e instanceof CompactionCancelledException) {
              cancelFlag?.set(true);
              return;
            }
            harnessLog('warn', 'Mid-loop compaction failed, continuing with the original next request', e);
          }
        }
      }

      listener.onMessageEnd(context.totalUsage);
    } finally {
      const sessionId = context.sessionId;
      if (sessionId != null) {
        this.cancelFlags.delete(sessionId);
        this.shellSessionManager.closeByConversation(sessionId);
        this.mcpClientManager.closeSession(sessionId);
        this.backgroundSubagentManager?.()?.clearResults(sessionId);
      }
    }
  }

  private async ensureContextAnchorLoaded(context: AgentExecutionContext): Promise<void> {
    if (context.sessionId == null) return;
    if (context.lastPromptTokens > 0 && context.contextAnchorMsgId > 0) return;
    try {
      const anchor = await this.sessionService.loadContextAnchor(context.sessionId);
      context.lastPromptTokens = anchor.lastPromptTokens;
      context.contextAnchorMsgId = anchor.contextAnchorMsgId;
    } catch {
      // ignore
    }
  }

  private computeActiveTokens(context: AgentExecutionContext, request: ChatRequest): number {
    return this.activeContextCalculator.activeFromMessageSuffix(
      context.lastPromptTokens,
      context.contextAnchorMsgId,
      context.messages,
      context.messagesCoveredByAnchor,
      request,
    );
  }

  private rollbackIncompleteRound(context: AgentExecutionContext, toolCalls: ToolCall[] | null): void {
    if (!toolCalls?.length) return;
    const toolCallIds = new Set(toolCalls.map((tc) => tc.id).filter((id): id is string => id != null));
    context.messages = context.messages.filter((m) => !(m.role === 'tool' && m.toolCallId && toolCallIds.has(m.toolCallId)));
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const msg = context.messages[i];
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        context.messages.splice(i, 1);
        break;
      }
    }
  }

  private async executeToolCalls(
    pendingCalls: ToolCall[],
    context: AgentExecutionContext,
    listener: AgentEventListener,
    pendingToolSaves: ToolMessageSave[],
    toolResults: Record<string, string>,
    cancelFlag: AtomicBoolean | null,
  ): Promise<void> {
    const runOne = (tc: ToolCall): Promise<string> => ToolCallContext.run(tc.id, () =>
      Promise.resolve(this.dispatchTool(tc.function?.name ?? '', tc.function?.arguments ?? '', context)),
    );

    if (pendingCalls.length === 1) {
      if (cancelFlag?.get()) return;
      const tc = pendingCalls[0];
      const rawResult = await runOne(tc);
      const toolSave = this.processToolResult(rawResult, tc, context);
      if (cancelFlag?.get()) return;
      tc.summary = ToolResultSummarizer.summarize(
        tc.function?.name ?? '', tc.function?.arguments ?? '', toolSave.content,
      ) ?? undefined;
      if (tc.id) toolResults[tc.id] = rawResult;
      context.addToolResult(tc.id!, toolSave.content);
      listener.onToolCallResult(tc.id!, rawResult);
      pendingToolSaves.push(toolSave);
      return;
    }

    const results = await Promise.all(pendingCalls.map((tc) => runOne(tc)));
    if (cancelFlag?.get()) return;
    for (let i = 0; i < pendingCalls.length; i++) {
      const tc = pendingCalls[i];
      const rawResult = results[i];
      const toolSave = this.processToolResult(rawResult, tc, context);
      tc.summary = ToolResultSummarizer.summarize(
        tc.function?.name ?? '', tc.function?.arguments ?? '', toolSave.content,
      ) ?? undefined;
      if (tc.id) toolResults[tc.id] = rawResult;
      context.addToolResult(tc.id!, toolSave.content);
      listener.onToolCallResult(tc.id!, rawResult);
      pendingToolSaves.push(toolSave);
    }
  }

  private processToolResult(rawResult: string, tc: ToolCall, context: AgentExecutionContext): ToolMessageSave {
    const diffStripped = FileChangeDiffUtil.stripPrivateDiff(rawResult) ?? rawResult;
    const supportsVision = context.modelConfig?.supportsVision === true;
    const processed = ToolImageResultProcessor.process(diffStripped, supportsVision);
    if (processed.attachment && tc.id) {
      context.registerToolAttachment(tc.id, processed.attachment);
    }
    return { toolCallId: tc.id!, content: processed.sanitizedContent ?? '', metadataJson: processed.metadataJson };
  }

  private async dispatchTool(toolName: string, argumentsJson: string, context: AgentExecutionContext): Promise<string> {
    if (!this.isToolAllowed(toolName, context)) {
      return `Tool execution failed: 工具 '${toolName}' 不在当前允许的工具集内，无法调用。`;
    }
    try {
      return await Promise.resolve(this.toolDispatcher.dispatch(
        toolName, argumentsJson, context.executionMode, context.sessionId, context.userId,
        context.workspace, context.permissionLevel, context.modelConfig, context.tools, context.executionUserId,
      ));
    } catch (e) {
      return 'Tool execution failed: ' + (e as Error).message;
    }
  }

  private isToolAllowed(toolName: string, context: AgentExecutionContext): boolean {
    if (!context.tools) return true;
    return context.tools.some((t: Tool) => t.getName() === toolName);
  }

  private mergeToolCall(
    existing: ToolCall[],
    delta: ToolCall,
    listener: AgentEventListener,
    emittedEarlyStarts: Set<string>,
  ): ToolCall | null {
    let merged = this.findMergeTarget(existing, delta);
    if (merged) {
      this.applyToolCallDelta(merged, delta);
    } else if (delta.id) {
      existing.push(delta);
      merged = delta;
    }
    // JS Set.add() returns the Set (always truthy); Java HashSet.add returns boolean.
    if (merged?.id && merged.function?.name && !emittedEarlyStarts.has(merged.id)) {
      emittedEarlyStarts.add(merged.id);
      listener.onToolCallStart(merged);
    }
    return merged ?? null;
  }

  private findMergeTarget(existing: ToolCall[], delta: ToolCall): ToolCall | undefined {
    if (delta.id) {
      return existing.find((tc) => tc.id === delta.id);
    }
    if (delta.index != null) {
      return existing.find((tc) => tc.index === delta.index) ?? existing[delta.index];
    }
    return existing.length > 0 ? existing[existing.length - 1] : undefined;
  }

  private applyToolCallDelta(target: ToolCall, delta: ToolCall): void {
    if (!target.function) target.function = { name: '', arguments: '' };
    if (!delta.function) return;
    if (delta.function.name) {
      // name 按规范一次性完整传输；部分网关会分片，此时只接受首个非空值，
      // 追加拼接会把 "read_" + "_file" 拼成 "read__file"
      if (!target.function.name) {
        target.function.name = delta.function.name;
      }
    }
    if (delta.function.arguments) {
      target.function.arguments = (target.function.arguments ?? '') + delta.function.arguments;
    }
  }
}
