package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.service.SessionCompactionService;
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
    private final SessionHistoryLoader sessionHistoryLoader;
    private final ContextManager contextManager;

    /**
     * @return 边界是否真的前进（persist 成功且重读边界等于候选边界）
     */
    public boolean compact(Long sessionId,
                           AgentExecutionContext context,
                           AgentEventListener listener,
                           CompactionConfig config,
                           boolean compactCurrentTurn,
                           Integer measuredRequestTokens) {
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
                compactCurrentTurn, measuredRequestTokens);
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
            log.info("Session compaction applied: boundary {} -> {}, {} messages, ~{} tokens saved",
                    boundary, latestBoundary, result.compactedCount(), result.savedTokens());
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
