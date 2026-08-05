package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 上下文窗口管理器
 * 提供 token 估算和上下文压缩能力
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ContextManager {

    private final TokenEstimator tokenEstimator;
    private final CompactionService compactionService;

    /**
     * Estimate token count for messages using UTF-8 bytes/4 heuristic
     */
    public int estimateTokens(List<ChatRequest.Message> messages) {
        return tokenEstimator.estimateMessages(messages);
    }

    /**
     * Estimate token count for a complete ChatRequest (messages + tool definitions)
     */
    public int estimateRequestTokens(ChatRequest request) {
        return tokenEstimator.estimateRequestTokens(request);
    }

    /**
     * 执行会话历史压缩
     */
    public CompactionService.SessionCompactionResult compactSession(
            Long sessionId, long expectedOldBoundary, String existingSummary,
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            LlmModelConfig modelConfig, CompactionConfig config,
            String currentUserQuestion) {
        return compactSession(sessionId, expectedOldBoundary, existingSummary, messages,
                snapshotMessageIds, modelConfig, config, currentUserQuestion, null, false, null);
    }

    public CompactionService.SessionCompactionResult compactSession(
            Long sessionId, long expectedOldBoundary, String existingSummary,
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            LlmModelConfig modelConfig, CompactionConfig config,
            String currentUserQuestion, AgentEventListener listener) {
        return compactSession(sessionId, expectedOldBoundary, existingSummary, messages,
                snapshotMessageIds, modelConfig, config, currentUserQuestion, listener, false, null);
    }

    public CompactionService.SessionCompactionResult compactSession(
            Long sessionId, long expectedOldBoundary, String existingSummary,
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            LlmModelConfig modelConfig, CompactionConfig config,
            String currentUserQuestion, AgentEventListener listener,
            boolean compactCurrentTurn, Integer measuredRequestTokens) {
        return compactionService.compactSession(
                sessionId, expectedOldBoundary, existingSummary, messages, snapshotMessageIds,
                modelConfig, config, currentUserQuestion, listener,
                compactCurrentTurn, measuredRequestTokens);
    }

    public List<ChatRequest.Message> prependSessionSummary(
            String summary, List<ChatRequest.Message> incrementalMessages) {
        return compactionService.prependSessionSummary(summary, incrementalMessages);
    }
}
