package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.LlmModelConfig;
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
     * Estimate token count for messages using cl100k_base tokenizer
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
            Long sessionId, List<ChatRequest.Message> messages,
            LlmModelConfig modelConfig, CompactionConfig config,
            String currentUserQuestion) {
        return compactionService.compactSession(sessionId, messages, modelConfig, config, currentUserQuestion);
    }

    /**
     * 执行 loop 工作记忆压缩
     */
    public CompactionService.LoopCompactionResult compactLoop(
            List<ChatRequest.Message> messages,
            LlmModelConfig modelConfig, CompactionConfig config,
            String existingWorkingSummary) {
        return compactionService.compactLoop(messages, modelConfig, config, existingWorkingSummary);
    }
}
