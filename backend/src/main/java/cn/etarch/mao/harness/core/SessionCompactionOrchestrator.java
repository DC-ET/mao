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

import java.util.List;

/**
 * 会话压缩编排：加载 → 压缩 → 持久化 → 重载 → 应用。
 * 请求开始与 mid-loop 共用；不调用 cleanupIncompleteTailAfterId（由请求开始路径自行处理）。
 */
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

    /**
     * @param measuredActiveTokens 统一活跃上下文 token（锚点+增量或全量估算）；可为 null（内部兜底）
     * @return 边界是否真的前进（persist 成功且重读边界等于候选边界）
     */
    public boolean compact(Long sessionId,
                           AgentExecutionContext context,
                           AgentEventListener listener,
                           CompactionConfig config,
                           boolean compactCurrentTurn,
                           Integer measuredActiveTokens) {
        SessionCompaction compactionRecord = sessionCompactionService.loadValidated(sessionId);
        long boundary = sessionCompactionService.boundaryOf(compactionRecord);
        String summary = compactionRecord != null ? compactionRecord.getSummaryText() : null;

        SessionHistoryLoader.HistorySnapshot history =
                sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, boundary);
        if (history.persistedMessages().isEmpty()) {
            return false;
        }

        String currentUserQuestion = findCurrentUserQuestion(history.persistedMessages());
        CompactionService.SessionCompactionResult result = contextManager.compactSession(
                sessionId, boundary, summary, history.persistedMessages(), history.snapshotMessageIds(),
                context.getModelConfig(), config, currentUserQuestion, listener,
                compactCurrentTurn, measuredActiveTokens);
        if (result == null) {
            return false;
        }

        boolean persisted = sessionCompactionService.persist(
                sessionId, compactionRecord, result.expectedOldBoundary(),
                result.newLastCompactedMessageId(), result.boundaryContentSnapshot(),
                result.summaryText(),
                result.inputTokens(), result.outputTokens(),
                context.getModelConfig() != null ? context.getModelConfig().getModelId() : null);
        if (!persisted) {
            log.info("Session compaction persist conflict or failed: sessionId={}, expectedBoundary={}, candidateBoundary={}",
                    sessionId, boundary, result.newLastCompactedMessageId());
        }

        // 无论 persist 成功与否都重载：失败时得到原状态，applyHistory 幂等
        SessionCompaction latest = sessionCompactionService.loadValidated(sessionId);
        long latestBoundary = sessionCompactionService.boundaryOf(latest);
        String latestSummary = latest != null ? latest.getSummaryText() : null;
        SessionHistoryLoader.HistorySnapshot latestHistory =
                sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, latestBoundary);
        sessionHistoryLoader.applyHistory(context, latestSummary, latestHistory);

        boolean advanced = persisted && latestBoundary == result.newLastCompactedMessageId();
        if (advanced) {
            String triggerMode = compactCurrentTurn ? "mid_loop" : "request_start";
            String compactModel = context.getModelConfig() != null ? context.getModelConfig().getModelId() : null;
            SessionCompactionEvent event = sessionCompactionEventService.record(
                    sessionId,
                    triggerMode,
                    result.expectedOldBoundary(),
                    result.newLastCompactedMessageId(),
                    result.compactedCount(),
                    result.summaryTokens(),
                    result.savedTokens(),
                    result.durationMs(),
                    compactModel);
            if (listener != null) {
                listener.onCompactionPersisted(
                        event.getId(),
                        triggerMode,
                        result.expectedOldBoundary(),
                        result.newLastCompactedMessageId(),
                        result.compactedCount(),
                        result.summaryTokens(),
                        result.savedTokens(),
                        result.durationMs());
            }

            // 压缩成功：清空 prompt 锚点，用全量字节/4 作为展示基线
            sessionService.clearContextAnchor(sessionId);
            context.setLastPromptTokens(0);
            context.setContextAnchorMsgId(0L);
            context.setMessagesCoveredByAnchor(-1);
            List<ChatRequest.Message> afterMsgs = latestHistory.persistedMessages().stream()
                    .map(PersistedChatMessage::chatMessage)
                    .toList();
            int baseline = activeContextCalculator.estimateMessages(afterMsgs)
                    + activeContextCalculator.estimateText(latestSummary);
            sessionService.updateContextTokens(sessionId, baseline);
            if (listener != null) {
                listener.onContextWindow(baseline, 0);
            }

            log.info("Session compaction applied: boundary {} -> {}, {} messages, ~{} tokens saved, trigger={}",
                    boundary, latestBoundary, result.compactedCount(), result.savedTokens(), triggerMode);
        }
        return advanced;
    }

    private String findCurrentUserQuestion(List<PersistedChatMessage> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatRequest.Message message = messages.get(i).chatMessage();
            if ("user".equals(message.getRole())) {
                return TokenEstimator.contentToString(message.getContent());
            }
        }
        return null;
    }
}
