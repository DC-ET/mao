package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.entity.SessionCompactionEvent;
import cn.etarch.mao.session.service.SessionCompactionEventService;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/** 会话交接压缩编排：快照 → 压缩 → CAS 持久化 → 重载应用。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionCompactionOrchestrator {

    private final SessionCompactionService sessionCompactionService;
    private final SessionCompactionEventService sessionCompactionEventService;
    private final SessionHistoryLoader sessionHistoryLoader;
    private final ContextManager contextManager;
    private final SessionService sessionService;
    private final ActiveContextCalculator activeContextCalculator;
    private final PromptEngine promptEngine;

    public boolean compact(Long sessionId,
                           AgentExecutionContext context,
                           ChatRequest normalRequest,
                           AgentEventListener listener,
                           CompactionConfig config,
                           boolean compactCurrentTurn,
                           AtomicBoolean cancelFlag) {
        SessionCompaction record = sessionCompactionService.loadValidated(sessionId);
        long boundary = sessionCompactionService.boundaryOf(record);
        String summary = record != null ? record.getSummaryText() : null;
        SessionHistoryLoader.HistorySnapshot history =
                sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, boundary);
        if (history.persistedMessages().isEmpty()) return false;

        CompactionService.SessionCompactionResult result = contextManager.compactSession(
                sessionId, boundary, history.persistedMessages(), history.snapshotMessageIds(),
                normalRequest, context.getModelConfig(), config, listener, cancelFlag);
        if (result == null) return false;

        boolean compactionEnded = false;
        boolean contextApplied = false;
        try {
        boolean persisted = sessionCompactionService.persist(
                sessionId, record, result.expectedOldBoundary(), result.newLastCompactedMessageId(),
                result.boundaryContentSnapshot(), result.summaryText(),
                result.promptTokens(), result.completionTokens(),
                context.getModelConfig() != null ? context.getModelConfig().getModelId() : null);
        if (!persisted) {
            log.info("Session compaction CAS conflict: sessionId={}, expectedBoundary={}, candidateBoundary={}",
                    sessionId, boundary, result.newLastCompactedMessageId());
        }

        SessionCompaction latest = sessionCompactionService.loadValidated(sessionId);
        long latestBoundary = sessionCompactionService.boundaryOf(latest);
        String latestSummary = latest != null ? latest.getSummaryText() : null;
        SessionHistoryLoader.HistorySnapshot latestHistory =
                sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, latestBoundary);
        sessionHistoryLoader.applyHistory(context, latestSummary, latestHistory);
        contextApplied = true;

        boolean advanced = persisted && latestBoundary == result.newLastCompactedMessageId();
        boolean contextChanged = latestBoundary != boundary || !Objects.equals(latestSummary, summary);
        ChatRequest afterRequest = null;
        int afterRequestTokens = 0;
        if (advanced || contextChanged) {
            afterRequest = promptEngine.buildRequest(context);
            afterRequestTokens = activeContextCalculator.estimateRequestTokens(afterRequest);
            resetContextAnchor(sessionId, context, afterRequestTokens, listener);
        }
        if (!advanced) {
            if (listener != null) {
                listener.onCompactionEnd("session", 0, 0, result.durationMs());
                compactionEnded = true;
            }
            return false;
        }

        int savedTokens = Math.max(0, result.beforeRequestTokens() - afterRequestTokens);
        String triggerMode = compactCurrentTurn ? "mid_loop" : "request_start";
        String compactModel = context.getModelConfig() != null ? context.getModelConfig().getModelId() : null;
        SessionCompactionEvent event = sessionCompactionEventService.record(
                sessionId, triggerMode, result.expectedOldBoundary(), result.newLastCompactedMessageId(),
                result.compactedCount(), result.promptTokens(), result.cachedTokens(),
                result.completionTokens(), result.summaryTokens(), savedTokens,
                result.durationMs(), compactModel);
        if (listener != null) {
            listener.onCompactionEnd("session", result.summaryTokens(), savedTokens, result.durationMs());
            compactionEnded = true;
            listener.onCompactionPersisted(event.getId(), triggerMode,
                    result.expectedOldBoundary(), result.newLastCompactedMessageId(),
                    result.compactedCount(), result.summaryTokens(), savedTokens, result.durationMs());
        }

        log.info("Session handoff applied: sessionId={}, boundary={} -> {}, promptTokens={}, cachedTokens={}, "
                        + "completionTokens={}, savedTokens={}, trigger={}",
                sessionId, boundary, latestBoundary, result.promptTokens(), result.cachedTokens(),
                result.completionTokens(), savedTokens, triggerMode);
        return true;
        } catch (RuntimeException e) {
            if (listener != null && !compactionEnded) {
                listener.onCompactionEnd("session", 0, 0, result.durationMs());
            }
            if (!contextApplied) {
                throw new CompactionStateReloadException(e);
            }
            throw e;
        }
    }

    public static class CompactionStateReloadException extends RuntimeException {
        public CompactionStateReloadException(Throwable cause) {
            super("会话压缩状态已发生变化但无法重新加载，请稍后重试", cause);
        }
    }

    private void resetContextAnchor(Long sessionId, AgentExecutionContext context,
                                    int requestTokens, AgentEventListener listener) {
        sessionService.clearContextAnchor(sessionId);
        context.setLastPromptTokens(0);
        context.setContextAnchorMsgId(0L);
        context.setMessagesCoveredByAnchor(-1);
        sessionService.updateContextTokens(sessionId, requestTokens);
        if (listener != null) {
            listener.onContextWindow(requestTokens, 0);
        }
    }
}
