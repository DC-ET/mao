import { randomUUID } from 'node:crypto';
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
import type { CompactionSignalBus } from './compaction-signal-bus.js';
import type { SessionActivityHeartbeat, SessionService } from '../deps.js';
import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { FileChangeDiffUtil } from '../tool/file-change-diff-util.js';
import { ToolCallContext } from '../tool/tool-call-context.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../../usage/llm-call-context.js';
import type { ToolDispatcher } from '../tool/tool-dispatcher.js';
import { ToolImageResultProcessor } from '../tool/tool-image-result-processor.js';
import { toolResultMeta, type ToolApprovalMark, type ToolResult } from '../tool/tool-result.js';
import { buildApprovalContextSnapshot } from '../tool/approval-context-snapshot.js';
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
  /** 后端截断事实（结果 JSON 顶层 truncated===true）：历史回放走 metadataJson，实时事件走此布尔并入 meta。 */
  resultTruncated?: boolean;
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
    private readonly compactionSignalBus?: CompactionSignalBus | null,
  ) {}

  registerCancelFlag(sessionId: number): AtomicBoolean {
    const flag = new AtomicBoolean(false);
    this.cancelFlags.set(sessionId, flag);
    return flag;
  }

  /**
   * 本实例正在执行的会话 id（取消标志的生命周期与一次执行严格对齐）。
   * 覆盖全部执行入口：桌面 WS、飞书/钉钉/微信入站、定时任务、子代理、崩溃恢复续跑——
   * 渠道入站执行不经过 StreamingWsHandler，只看它的 claim 集合会漏判"实例仍忙碌"。
   */
  listActiveSessionIds(): number[] {
    return [...this.cancelFlags.keys()];
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
    const heartbeatSessionId = context.sessionId;
    // 长工具调用期间轮级 touch 不会触发，这里挂独立心跳，避免执行中被误判为孤儿会话。
    this.activityHeartbeat.start(heartbeatSessionId);
    // 双向清理（技术方案 5.4）：丢弃上一轮执行结束前未被消费的陈旧手动信号，
    // 否则下一次执行首个工具轮边界会发生一次用户未请求的压缩。
    if (heartbeatSessionId != null) this.compactionSignalBus?.clear(heartbeatSessionId);
    try {
      let pendingSave: string | null = null;
      let pendingThinking: string | null = null;
      let pendingSaveUsage: ChatUsage | null = null;
      let pendingSaveToolCalls: ToolCall[] | null = null;
      let roundOpen = false;

      await this.ensureContextAnchorLoaded(context);

      while (true) {
        round++;
        context.currentRound = round;
        listener.onRoundStart?.(round);
        roundOpen = true;
        const usageBeforeRound: ChatUsage = { ...context.totalUsage };
        /** 收掉当前轮：onRoundStart/onRoundEnd 必须成对。取消路径统一走这里。 */
        const closeRound = () => {
          if (!roundOpen) return;
          roundOpen = false;
          listener.onRoundEnd?.(round);
        };
        /** 取消收尾：丢弃本轮未完成用量（消息已 rollback，不应记为正常完成），并关轮。 */
        const abortRound = () => {
          context.totalUsage = usageBeforeRound;
          closeRound();
        };
        const sessionId = context.sessionId;
        this.activityHeartbeat.touch(sessionId);
        const cancelFlag = this.resolveCancelFlag(context);
        if (await this.isCancelled(context)) {
          cancelFlag?.set(true);
          abortRound();
          break;
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
        listener.onContextWindow?.(estimatedTokens, context.lastPromptTokens > 0 ? context.lastPromptTokens : 0, context.contextManifest);

        const currentRound = round;
        let emptyResponseEncountered = false;
        const emptyBackoffMs = { v: 0 };
        const emptyRetryInfo = { attempt: 0, maxRetries: 10 };
        const thinkingActive = { v: false };
        const emittedEarlyStarts = new Set<string>();
        // thinking_start 惰性发送：仅当模型真正输出首个推理增量时才标记思考开始。
        // 之前在每轮 LLM 调用前无条件发送，模型不输出推理内容时（纯工具调用轮很常见），
        // thinking 状态会横跨整轮，导致前端把上一轮已完成的思考块重新点亮为“思考中”。
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
                if (!thinkingActive.v) {
                  thinkingActive.v = true;
                  listener.onThinkingStart?.();
                }
                thinkingBuilder.push(delta.reasoningContent);
                listener.onThinkingDelta?.(delta.reasoningContent);
              }
              if (delta.content) {
                if (thinkingActive.v) {
                  thinkingActive.v = false;
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
              if (thinkingActive.v) {
                thinkingActive.v = false;
                listener.onThinkingEnd?.();
              }
              context.addUsage(usage);
              const content = contentBuilder.join('');
              const thinkingContent = thinkingBuilder.length > 0 ? thinkingBuilder.join('') : null;
              if (content !== '' || toolCalls.length > 0) {
                // 收到有效输出即复位计数，保证"连续 10 次空响应"语义
                emptyResponseCount = 0;
                context.addAssistantMessage(content, toolCalls, thinkingContent);
                if (usage && usage.promptTokens > 0) {
                  const promptTokens = usage.promptTokens;
                  const anchorMsgId = preRequestMaxMsgId > 0 ? preRequestMaxMsgId : context.contextAnchorMsgId;
                  context.lastPromptTokens = promptTokens;
                  context.contextAnchorMsgId = anchorMsgId;
                  context.messagesCoveredByAnchor = messagesCoveredThisRound;
                  if (context.sessionId != null && anchorMsgId > 0) {
                    afterStream.push(this.sessionService.updateContextAnchor(context.sessionId, promptTokens, anchorMsgId));
                  }
                  listener.onContextWindow?.(promptTokens, promptTokens, context.contextManifest);
                }
                if (toolCalls.length > 0) {
                  for (const tc of toolCalls) {
                    // 与 Java 版一致：流结束时用完整参数刷新监听器缓存。
                    // 监听器会去重 start 事件，但摘要器随后需要这里的最终 arguments。
                    listener.onToolCallStart(tc);
                  }
                  context.pendingToolCalls = toolCalls;
                }
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
                // 注意：空响应轮不更新 context anchor、不向 afterStream 压 promise——
                // 否则 EmptyResponseExhaustedException 会在 catch 中 rethrow，
                // afterStream 永远不会被 await，形成 unhandled rejection 与错误锚点。
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
              throw t;
            },
            onStreamReset: () => {
              if (thinkingActive.v) {
                thinkingActive.v = false;
                listener.onThinkingEnd?.();
              }
              contentBuilder.length = 0;
              thinkingBuilder.length = 0;
              toolCalls.length = 0;
              emittedEarlyStarts.clear();
              listener.onLlmStreamReset?.();
            },
            onWaiting: (phase, elapsed) => listener.onLlmWaiting?.(phase, elapsed),
            onRetry: (reason, statusCode, attempt, maxRetries, delaySeconds) => {
              listener.onLlmRetry?.(reason, statusCode, attempt, maxRetries, delaySeconds);
            },
          };

          await LlmCallContext.runAsync({
            scene: LLM_CALL_SCENES.AGENT,
            userId: context.executionUserId ?? context.userId ?? null,
            sessionId: context.sessionId ?? null,
            agentId: context.agentId ?? null,
          }, async () => {
            await this.llmAdapter.stream(request, context.modelConfig!, callback, cancelFlag ?? null);
          });
          await Promise.all(afterStream);
        } catch (e) {
          if (thinkingActive.v) {
            thinkingActive.v = false;
            listener.onThinkingEnd?.();
          }
          if (e instanceof Error && e.message.includes('Cancelled by user')) {
            harnessLog('info', `Agent loop round ${currentRound} cancelled by user for session ${sessionId}`);
            abortRound();
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
            // 与正常轮次对齐：start/end 必须成对，否则前端回合状态错乱
            closeRound();
            continue;
          }
          const bgSubagentManager = this.backgroundSubagentManager?.();
          if (bgSubagentManager?.hasRunning(sessionId ?? null) || bgSubagentManager?.hasPendingResults(sessionId ?? null)) {
            await bgSubagentManager.waitForAll(sessionId ?? null, cancelFlag ?? null);
            if (await this.isCancelled(context)) {
              cancelFlag?.set(true);
              abortRound();
              break;
            }
            context.clearPendingToolCalls();
            // 与空响应/正常轮次对齐：start/end 必须成对，否则前端回合状态错乱
            closeRound();
            continue;
          }
          closeRound();
          // 纯文本收尾不再有下一工具轮。已回执「已排队」的手动整理必须在退出前消费，
          // 否则 finally 清信号会让这次整理既不发生、也没有失败回执。
          if (await this.consumeManualCompaction(context, listener, persistenceCallback, cancelFlag ?? null)) {
            abortRound();
          }
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
          abortRound();
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
        closeRound();

        // 手动压缩信号消费（技术方案 5.4 / 决策 12）：必须置于 midLoopAllowed 门外——
        // enabled=false 只关「自动整理」，不得连带禁用用户显式的手动压缩。
        if (await this.consumeManualCompaction(context, listener, persistenceCallback, cancelFlag ?? null)) {
          abortRound();
          break;
        }
        const loopConfig = context.compactionConfig;
        const midLoopAllowed = loopConfig != null
          && loopConfig.enabled && loopConfig.loopMidwayCompact
          && persistenceCallback != null
          && context.sessionId != null;
        if (midLoopAllowed && loopConfig) {
          try {
            const nextRequest = await this.promptEngine.buildRequest(context);
            const nextRequestTokens = this.computeActiveTokens(context, nextRequest);
            listener.onContextWindow?.(nextRequestTokens, context.lastPromptTokens > 0 ? context.lastPromptTokens : 0, context.contextManifest);
            const effectiveContextWindow = CompactionConfig.resolveEffectiveContextWindow(context.modelConfig, loopConfig);
            if (nextRequestTokens >= effectiveContextWindow * loopConfig.triggerRatio) {
              await this.sessionCompactionOrchestrator.compact(
                context.sessionId!, context, nextRequest, listener, loopConfig, true, cancelFlag ?? null, nextRequestTokens, 'mid_loop');
              context.preparedRequest = await this.promptEngine.buildRequest(context);
            }
          } catch (e) {
            if (e instanceof CompactionContextOverflowException || e instanceof CompactionStateReloadException) throw e;
            if (e instanceof CompactionCancelledException) {
              cancelFlag?.set(true);
              abortRound();
              break;
            }
            harnessLog('warn', 'Mid-loop compaction failed, continuing with the original next request', e);
          }
        }
      }

      listener.onMessageEnd(context.totalUsage);
    } finally {
      const sessionId = context.sessionId;
      this.activityHeartbeat.stop(heartbeatSessionId);
      if (sessionId != null) {
        this.cancelFlags.delete(sessionId);
        this.compactionSignalBus?.clear(sessionId);
        this.shellSessionManager.closeByConversation(sessionId);
        this.mcpClientManager.closeSession(sessionId);
        this.backgroundSubagentManager?.()?.clearResults(sessionId);
      }
    }
  }

  /**
   * 消费运行中的手动压缩信号。工具轮边界与纯文本收尾共用。
   * 前提与空闲路径对齐（持久化回调 + 会话 id + 配置对象）；不满足时不消费，留给 finally 清理。
   * @returns 压缩被用户取消时为 true，调用方应中止循环。
   */
  private async consumeManualCompaction(
    context: AgentExecutionContext,
    listener: AgentEventListener,
    persistenceCallback: MessagePersistenceCallback | null | undefined,
    cancelFlag: AtomicBoolean | null,
  ): Promise<boolean> {
    const loopConfig = context.compactionConfig;
    if (!(this.compactionSignalBus && context.sessionId != null
      && persistenceCallback != null && loopConfig
      && this.compactionSignalBus.consume(context.sessionId))) {
      return false;
    }
    try {
      const manualRequest = await this.promptEngine.buildRequest(context);
      const manualTokens = this.computeActiveTokens(context, manualRequest);
      listener.onContextWindow?.(manualTokens, context.lastPromptTokens > 0 ? context.lastPromptTokens : 0, context.contextManifest);
      await this.sessionCompactionOrchestrator.compact(
        context.sessionId, context, manualRequest, listener, loopConfig, true, cancelFlag,
        manualTokens, 'manual', true);
      context.preparedRequest = await this.promptEngine.buildRequest(context);
      return false;
    } catch (e) {
      if (e instanceof CompactionContextOverflowException || e instanceof CompactionStateReloadException) throw e;
      if (e instanceof CompactionCancelledException) {
        cancelFlag?.set(true);
        return true;
      }
      harnessLog('warn', 'Manual compaction at loop boundary failed, continuing with the next request', e);
      return false;
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
    const runOne = (tc: ToolCall): Promise<ToolResult> => ToolCallContext.run(tc.id, () =>
      Promise.resolve(this.dispatchTool(tc, context)),
    );

    if (pendingCalls.length === 1) {
      if (cancelFlag?.get()) return;
      const tc = pendingCalls[0];
      const result = await runOne(tc);
      const rawResult = result.content;
      const toolSave = this.processToolResult(rawResult, tc, context, result.approvalMark);
      if (cancelFlag?.get()) return;
      tc.summary = ToolResultSummarizer.summarize(
        tc.function?.name ?? '', tc.function?.arguments ?? '', toolSave.content,
      ) ?? undefined;
      if (tc.id) toolResults[tc.id] = rawResult;
      context.addToolResult(tc.id!, toolSave.content);
      listener.onToolCallResult(tc.id!, rawResult, { ...toolResultMeta(result), resultTruncated: toolSave.resultTruncated });
      pendingToolSaves.push(toolSave);
      return;
    }

    if (cancelFlag?.get()) return;
    const results = await Promise.all(pendingCalls.map((tc) => runOne(tc)));
    if (cancelFlag?.get()) return;
    for (let i = 0; i < pendingCalls.length; i++) {
      const tc = pendingCalls[i];
      const result = results[i];
      const rawResult = result.content;
      const toolSave = this.processToolResult(rawResult, tc, context, result.approvalMark);
      tc.summary = ToolResultSummarizer.summarize(
        tc.function?.name ?? '', tc.function?.arguments ?? '', toolSave.content,
      ) ?? undefined;
      if (tc.id) toolResults[tc.id] = rawResult;
      context.addToolResult(tc.id!, toolSave.content);
      listener.onToolCallResult(tc.id!, rawResult, { ...toolResultMeta(result), resultTruncated: toolSave.resultTruncated });
      pendingToolSaves.push(toolSave);
    }
  }

  private processToolResult(
    rawResult: string, tc: ToolCall, context: AgentExecutionContext,
    approvalMark?: ToolApprovalMark | null,
  ): ToolMessageSave {
    const diffStripped = FileChangeDiffUtil.stripPrivateDiff(rawResult) ?? rawResult;
    const supportsVision = context.modelConfig?.supportsVision === true;
    const processed = ToolImageResultProcessor.process(diffStripped, supportsVision);
    if (processed.attachment && tc.id) {
      context.registerToolAttachment(tc.id, processed.attachment);
    }
    // 技术方案 5.6：嗅探结果 JSON 顶层 truncated===true（grep/glob/read_file 等口径统一），
    // 命中即落 metadataJson（历史回放）并带回布尔（实时事件走 meta 通道）。非 JSON 静默跳过。
    const resultTruncated = sniffResultTruncated(rawResult);
    return {
      toolCallId: tc.id!,
      content: processed.sanitizedContent ?? '',
      metadataJson: mergeResultTruncated(mergeApprovalMark(processed.metadataJson, approvalMark), resultTruncated),
      resultTruncated: resultTruncated || undefined,
    };
  }

  private async dispatchTool(tc: ToolCall, context: AgentExecutionContext): Promise<ToolResult> {
    const toolName = tc.function?.name ?? '';
    const argumentsJson = tc.function?.arguments ?? '';
    if (!this.isToolAllowed(toolName, context)) {
      return {
        callId: tc.id ?? '',
        status: 'error',
        content: `Tool execution failed: 工具 '${toolName}' 不在当前允许的工具集内，无法调用。`,
        errorMessage: 'tool not allowed',
      };
    }
    return this.toolDispatcher.dispatchInvocation({
      callId: tc.id ?? '',
      toolName,
      argumentsJson,
      executionMode: context.executionMode ?? null,
      sessionId: context.sessionId ?? null,
      userId: context.userId ?? null,
      executionUserId: context.executionUserId ?? null,
      workspace: context.workspace ?? null,
      permissionLevel: context.permissionLevel ?? null,
      modelConfig: context.modelConfig ?? null,
      sessionTools: context.tools ?? null,
      // LOCAL 一律构建快照（而非仅 PROXY 时）：dispatcher 每次从 DB 重读最新级别，
      // 用户执行中切换到 PROXY 时 context 里的级别可能是旧值
      contextSnapshot: context.executionMode === 'LOCAL' ? buildApprovalContextSnapshot(context.messages) : null,
    });
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
    } else if (delta.id || delta.index != null) {
      // 无 id、仅 index 的分片（部分 OpenAI 兼容网关不回传 id）必须按新 tool call 追加，
      // 否则 findMergeTarget 按 index 落空且 push 分支要求 id，整段调用被静默丢弃。
      if (!delta.id) {
        // 追加时即合成稳定 id：派发、toolResults 簿记、TOOL 消息配对（normalizeChatMessages
        // 的 deferredTools）、serializeToolCall 全都要求 id 非空，缺 id 时第 2 轮起工具结果
        // 会被整体剥掉、严格网关还会因 tool_calls[].id 缺失 400。
        // 不能用 index 推导——同一 index 会在后续轮次复用，配对表会跨轮错并；随机 id 由本条
        // 调用持有终身，同 index 的后续分片经 findMergeTarget 归并到同一对象。
        delta.id = `call-${randomUUID()}`;
      }
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
      const byId = existing.find((tc) => tc.id === delta.id);
      if (byId) return byId;
      // 首片无 id 的调用已被合成 id 占位：后续分片带回真实 id 时按 index 归并，
      // 否则同一调用会被拆成两条 tool call 重复派发
      if (delta.index != null) {
        return existing.find((tc) => tc.index === delta.index);
      }
      return undefined;
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

/** 把 AI 审批标记合并进工具消息 metadata（与图片附件等既有 key 共存），供持久化与前端徽标展示。 */
function mergeApprovalMark(metadataJson: string | null, approvalMark?: ToolApprovalMark | null): string | null {
  if (!approvalMark) return metadataJson;
  let root: Record<string, unknown> = {};
  if (metadataJson != null && metadataJson.trim() !== '') {
    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // 既有 metadata 不是 JSON 对象时丢弃，审批标记优先保留
    }
  }
  root.approvalMark = approvalMark;
  return JSON.stringify(root);
}

/** 结果 JSON 可 parse 且顶层 `truncated === true` 判为后端截断；非 JSON / 缺字段返回 false。 */
function sniffResultTruncated(rawResult: string): boolean {
  try {
    const parsed = JSON.parse(rawResult) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).truncated === true;
  } catch {
    return false;
  }
}

/** 把截断标识并入工具消息 metadata（与 approvalMark / 图片附件等既有 key 共存），供历史回放展示徽标。 */
function mergeResultTruncated(metadataJson: string | null, truncated: boolean): string | null {
  if (!truncated) return metadataJson;
  let root: Record<string, unknown> = {};
  if (metadataJson != null && metadataJson.trim() !== '') {
    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // 既有 metadata 非 JSON 对象时丢弃，截断标识优先保留
    }
  }
  root.resultTruncated = true;
  return JSON.stringify(root);
}
