package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** 上下文窗口估算和会话交接压缩入口。 */
@Component
@RequiredArgsConstructor
public class ContextManager {

    private final TokenEstimator tokenEstimator;
    private final CompactionService compactionService;

    public int estimateTokens(List<ChatRequest.Message> messages) {
        return tokenEstimator.estimateMessages(messages);
    }

    public int estimateRequestTokens(ChatRequest request) {
        return tokenEstimator.estimateRequestTokens(request);
    }

    public CompactionService.SessionCompactionResult compactSession(
            Long sessionId, long expectedOldBoundary,
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            ChatRequest normalRequest, LlmModelConfig modelConfig, CompactionConfig config,
            AgentEventListener listener, AtomicBoolean cancelFlag) {
        return compactionService.compactSession(sessionId, expectedOldBoundary, messages,
                snapshotMessageIds, normalRequest, modelConfig, config, listener, cancelFlag);
    }

    public List<ChatRequest.Message> prependSessionSummary(
            String summary, List<ChatRequest.Message> incrementalMessages) {
        return compactionService.prependSessionSummary(summary, incrementalMessages);
    }
}
