package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class TokenEstimatorTest {

    private final TokenEstimator estimator = new TokenEstimator(new ObjectMapper());

    @Test
    void contentToStringHandlesPlainTextContentPartsAndMaps() {
        ChatRequest.ContentPart part = ChatRequest.ContentPart.builder()
                .type("text")
                .text("hello")
                .build();

        assertThat(TokenEstimator.contentToString("plain")).isEqualTo("plain");
        assertThat(TokenEstimator.contentToString(List.of(part, Map.of("type", "text", "text", " map"))))
                .isEqualTo("hello map");
        assertThat(TokenEstimator.contentToString(null)).isEmpty();
        assertThat(TokenEstimator.contentToString(123)).isEqualTo("123");
    }

    @Test
    void estimatesMessagesToolCallsDefinitionsAndWholeRequests() {
        ChatRequest.ToolCall toolCall = ChatRequest.ToolCall.builder()
                .id("call-1")
                .function(ChatRequest.FunctionCall.builder()
                        .name("read_file")
                        .arguments("{\"path\":\"README.md\"}")
                        .build())
                .build();
        ChatRequest.Message assistant = ChatRequest.Message.builder()
                .role("assistant")
                .content("I'll read it")
                .toolCalls(List.of(toolCall))
                .build();
        ChatRequest.Message tool = ChatRequest.Message.builder()
                .role("tool")
                .toolCallId("call-1")
                .content("content")
                .build();
        ChatRequest.ToolDefinition definition = ChatRequest.ToolDefinition.builder()
                .type("function")
                .function(ChatRequest.Function.builder()
                        .name("read_file")
                        .description("Read a file")
                        .parameters(Map.of("type", "object", "required", List.of("path")))
                        .build())
                .build();
        ChatRequest request = ChatRequest.builder()
                .messages(List.of(assistant, tool))
                .tools(List.of(definition))
                .build();

        assertThat(estimator.countTokens("hello world")).isPositive();
        assertThat(estimator.estimateMessage(assistant)).isPositive();
        assertThat(estimator.estimateMessages(List.of(assistant, tool))).isGreaterThan(estimator.estimateMessage(assistant));
        assertThat(estimator.estimateToolDefinitions(List.of(definition))).isPositive();
        assertThat(estimator.estimateRequestTokens(request)).isGreaterThan(estimator.estimateMessages(List.of(assistant, tool)));
    }
}
