import type { ChatRequest } from '../llm/chat-request.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { AgentExecutionContext } from './agent-execution-context.js';
import type { CompactionArchiveService } from './compaction-archive.service.js';
import type { CompactionConfig } from './compaction-config.js';
import type { ActiveContextCalculator } from './active-context-calculator.js';
import type { ContextManager } from './context-manager.js';
import type { PromptEngine } from './prompt-engine.js';
import type { SessionHistoryLoader } from './session-history-loader.js';
import type { SessionCompactionEventService, SessionCompactionService, SessionService } from '../deps.js';
import { harnessLog } from '../log.js';

export class CompactionStateReloadException extends Error {
  constructor(cause?: unknown) {
    super('会话压缩状态已发生变化但无法重新加载，请稍后重试');
    this.name = 'CompactionStateReloadException';
    this.cause = cause;
  }
}

export class SessionCompactionOrchestrator {
  constructor(
    private readonly sessionCompactionService: SessionCompactionService,
    private readonly sessionCompactionEventService: SessionCompactionEventService,
    private readonly sessionHistoryLoader: SessionHistoryLoader,
    private readonly contextManager: ContextManager,
    private readonly sessionService: SessionService,
    private readonly activeContextCalculator: ActiveContextCalculator,
    private readonly promptEngine: PromptEngine,
    private readonly compactionArchiveService: CompactionArchiveService,
  ) {}

  async compact(
    sessionId: number,
    context: AgentExecutionContext,
    normalRequest: ChatRequest,
    listener: AgentEventListener | null,
    config: CompactionConfig,
    compactCurrentTurn: boolean,
    cancelFlag: { get(): boolean } | null,
    activeTokensHint?: number | null,
  ): Promise<boolean> {
    const record = await this.sessionCompactionService.loadValidated(sessionId);
    const boundary = this.sessionCompactionService.boundaryOf(record);
    const summary = record?.summaryText ?? null;
    const history = await this.sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, boundary);
    if (history.persistedMessages.length === 0) return false;

    const result = await this.contextManager.compactSession(
      sessionId, boundary, history.persistedMessages, history.snapshotMessageIds,
      normalRequest, context.modelConfig!, config, listener, cancelFlag, activeTokensHint ?? null);
    if (result == null) return false;

    let compactionEnded = false;
    let contextApplied = false;
    try {
      const persisted = await this.sessionCompactionService.persist(
        sessionId, record, result.expectedOldBoundary, result.newLastCompactedMessageId,
        result.boundaryContentSnapshot, result.summaryText,
        result.promptTokens, result.completionTokens,
        context.modelConfig?.modelId ?? null);
      if (!persisted) {
        harnessLog('info', `Session compaction CAS conflict: sessionId=${sessionId}`);
      }
      const latest = await this.sessionCompactionService.loadValidated(sessionId);
      const latestBoundary = this.sessionCompactionService.boundaryOf(latest);
      const latestSummary = latest?.summaryText ?? null;
      const latestHistory = await this.sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, latestBoundary);
      // 归档必须先于 applyHistory：首次压缩时 hint 构建依赖归档目录已非空；
      // 判据用 persisted（CAS 获胜），即使随后被并发压缩超越，本线程区间也已落档
      if (persisted) {
        this.compactionArchiveService.writeArchive(
          context.executionMode, context.userId, context.sessionId,
          latest?.compactCount ?? 1,
          history.normalizedEntities.filter((m) => m.id != null
            && m.id > boundary && m.id <= result.newLastCompactedMessageId),
        );
      }
      this.sessionHistoryLoader.applyHistory(context, latestSummary, latestHistory);
      contextApplied = true;

      const advanced = persisted && latestBoundary === result.newLastCompactedMessageId;
      const contextChanged = latestBoundary !== boundary || latestSummary !== summary;
      let afterRequestTokens = 0;
      if (advanced || contextChanged) {
        const afterRequest = await this.promptEngine.buildRequest(context);
        afterRequestTokens = this.activeContextCalculator.estimateRequestTokens(afterRequest);
        await this.resetContextAnchor(sessionId, context, afterRequestTokens, listener);
      }
      if (!advanced) {
        listener?.onCompactionEnd?.('session', 0, 0, result.durationMs);
        compactionEnded = true;
        return false;
      }
      const savedTokens = Math.max(0, result.beforeRequestTokens - afterRequestTokens);
      const triggerMode = compactCurrentTurn ? 'mid_loop' : 'request_start';
      const event = await this.sessionCompactionEventService.record(
        sessionId, triggerMode, result.expectedOldBoundary, result.newLastCompactedMessageId,
        result.compactedCount, result.promptTokens, result.cachedTokens,
        result.completionTokens, result.summaryTokens, savedTokens,
        result.durationMs, context.modelConfig?.modelId ?? null);
      listener?.onCompactionEnd?.('session', result.summaryTokens, savedTokens, result.durationMs);
      compactionEnded = true;
      listener?.onCompactionPersisted?.(
        event.id!, triggerMode, result.expectedOldBoundary, result.newLastCompactedMessageId,
        result.compactedCount, result.summaryTokens, savedTokens, result.durationMs);
      return true;
    } catch (e) {
      if (listener && !compactionEnded) {
        listener.onCompactionEnd?.('session', 0, 0, result.durationMs);
      }
      if (!contextApplied) throw new CompactionStateReloadException(e);
      throw e;
    }
  }

  private async resetContextAnchor(
    sessionId: number, context: AgentExecutionContext, requestTokens: number, listener: AgentEventListener | null,
  ): Promise<void> {
    await this.sessionService.clearContextAnchor(sessionId);
    context.lastPromptTokens = 0;
    context.contextAnchorMsgId = 0;
    context.messagesCoveredByAnchor = -1;
    await this.sessionService.updateContextTokens(sessionId, requestTokens);
    listener?.onContextWindow?.(requestTokens, 0);
  }
}
