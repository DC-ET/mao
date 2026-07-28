package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;

/** Internal message representation that keeps persistence state out of the LLM protocol DTO. */
public record PersistedChatMessage(
        Long messageId,
        String persistedContentSnapshot,
        ChatRequest.Message chatMessage) {

    public PersistedChatMessage(Long messageId, ChatRequest.Message chatMessage) {
        this(messageId, TokenEstimator.contentToString(chatMessage.getContent()), chatMessage);
    }
}
