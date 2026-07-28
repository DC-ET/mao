package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.harness.llm.LlmAdapter;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CompactionServiceTest {

    private final LlmAdapter llmAdapter = mock(LlmAdapter.class);
    private final TokenEstimator tokenEstimator = mock(TokenEstimator.class);
    private final CompactionService service = new CompactionService(llmAdapter, tokenEstimator);

    @Test
    void writesRealBoundaryAndKeepsCompleteRecentTurns() {
        triggerCompaction("summary text");
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(1);
        config.setMaxCompactionBatchMessages(2);

        List<PersistedChatMessage> messages = List.of(
                message(10, "user"),
                message(25, "assistant"),
                message(40, "user"),
                message(41, "assistant"),
                message(100, "user"));

        AgentEventListener listener = mock(AgentEventListener.class);
        var result = service.compactSession(
                3L, 0, null, messages, ids(messages),
                modelConfig(), config, "current question", listener);

        assertThat(result).isNotNull();
        verify(listener).onCompactionStart("session", 2, 10_000);
        verify(listener).onCompactionEnd(eq("session"), eq(10), eq(9_990), anyLong());
        assertThat(result.newLastCompactedMessageId()).isEqualTo(25L);
        assertThat(result.expectedOldBoundary()).isZero();
        assertThat(result.boundaryContentSnapshot()).isEqualTo("assistant 25" + " ".repeat(20));
        assertThat(result.compactedCount()).isEqualTo(2);
        assertThat(result.summaryText()).isEqualTo("summary text");
    }

    @Test
    void toolTurnLargerThanBatchLimitIsNeverSplit() {
        triggerCompaction("tool summary");
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(1);
        config.setMaxCompactionBatchMessages(2);

        List<PersistedChatMessage> normalized = List.of(
                message(1, "user"),
                message(4, "assistant"),
                message(2, "tool"),
                message(3, "tool"),
                message(5, "assistant"),
                message(10, "user"),
                message(11, "assistant"),
                message(20, "user"));

        var result = service.compactSession(
                9L, 0, null, normalized, List.of(1L, 2L, 3L, 4L, 5L, 10L, 11L, 20L),
                modelConfig(), config, null);

        assertThat(result).isNotNull();
        assertThat(result.newLastCompactedMessageId()).isEqualTo(5L);
        assertThat(result.compactedCount()).isEqualTo(5);
        verify(llmAdapter, times(1)).chat(any(), any());

        ArgumentCaptor<ChatRequest> requestCaptor = ArgumentCaptor.forClass(ChatRequest.class);
        verify(llmAdapter).chat(requestCaptor.capture(), any());
        String prompt = requestCaptor.getValue().getMessages().get(0).getContent().toString();
        assertThat(prompt).contains("用户:", "助手:", "工具结果");
    }

    @Test
    void currentUserTurnIsAlwaysRetainedWhenRecentTurnsIsZero() {
        triggerCompaction("summary");
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(0);

        List<PersistedChatMessage> messages = List.of(
                message(1, "user"), message(2, "assistant"),
                message(10, "user"), message(11, "assistant"),
                message(20, "user"));

        var result = service.compactSession(
                1L, 0, null, messages, ids(messages), modelConfig(), config, null);

        assertThat(result).isNotNull();
        assertThat(result.newLastCompactedMessageId()).isEqualTo(11L);
        assertThat(result.compactedCount()).isEqualTo(4);
    }

    @Test
    void includesLeadingAssistantAndToolMessagesAfterUserBoundary() {
        triggerCompaction("merged summary");
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(1);

        // Boundary was at USER 100; incremental history starts with that turn's tail.
        List<PersistedChatMessage> messages = List.of(
                message(101, "assistant"),
                message(102, "tool"),
                message(110, "user"),
                message(111, "assistant"),
                message(200, "user"));

        var result = service.compactSession(
                5L, 100L, "existing summary", messages, ids(messages),
                modelConfig(), config, "current question");

        assertThat(result).isNotNull();
        assertThat(result.newLastCompactedMessageId()).isEqualTo(102L);
        assertThat(result.compactedCount()).isEqualTo(2);

        ArgumentCaptor<ChatRequest> requestCaptor = ArgumentCaptor.forClass(ChatRequest.class);
        verify(llmAdapter).chat(requestCaptor.capture(), any());
        String prompt = requestCaptor.getValue().getMessages().get(0).getContent().toString();
        assertThat(prompt).contains("assistant 101", "tool 102");
    }

    @Test
    void rejectsBoundaryThatWouldSkipAnUnsummarizedPhysicalPrefixMessage() {
        triggerCompaction("unsafe summary");
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(0);

        // The current USER row was persisted before the prior ASSISTANT row.
        List<PersistedChatMessage> normalized = List.of(
                message(10, "user"), message(30, "assistant"), message(20, "user"));

        var result = service.compactSession(
                1L, 0, null, normalized, List.of(10L, 20L, 30L),
                modelConfig(), config, null);

        assertThat(result).isNull();
    }

    @Test
    void persistsLastSafeBatchWhenALaterBatchFails() {
        when(tokenEstimator.estimateMessages(any())).thenReturn(10_000);
        when(tokenEstimator.countTokens(any())).thenReturn(10);
        when(llmAdapter.chat(any(), any()))
                .thenReturn(summaryResponse("<summary>first</summary>"))
                .thenReturn(null);
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(0);
        config.setMaxCompactionBatchMessages(2);

        List<PersistedChatMessage> messages = List.of(
                message(1, "user"), message(2, "assistant"),
                message(3, "user"), message(4, "assistant"),
                message(5, "user"), message(6, "assistant"),
                message(7, "user"));

        var result = service.compactSession(
                1L, 0, "old", messages, ids(messages), modelConfig(), config, null);

        assertThat(result).isNotNull();
        assertThat(result.summaryText()).isEqualTo("first");
        assertThat(result.newLastCompactedMessageId()).isEqualTo(2L);
        assertThat(result.compactedCount()).isEqualTo(2);
        verify(llmAdapter, times(2)).chat(any(), any());
    }

    @Test
    void returnsNullWhenDisabledTooSmallOrLlmFails() {
        CompactionConfig disabled = aggressiveSessionConfig();
        disabled.setEnabled(false);
        assertThat(service.compactSession(
                1L, 0, null, List.of(message(1, "user")), List.of(1L),
                modelConfig(), disabled, null)).isNull();

        assertThat(service.compactSession(
                1L, 0, null, List.of(), List.of(),
                modelConfig(), aggressiveSessionConfig(), null)).isNull();

        when(tokenEstimator.estimateMessages(any())).thenReturn(20_000);
        when(llmAdapter.chat(any(), any())).thenReturn(null);
        List<PersistedChatMessage> messages = List.of(
                message(1, "user"), message(2, "assistant"), message(3, "user"));
        assertThat(service.compactSession(
                1L, 0, null, messages, ids(messages),
                modelConfig(), aggressiveSessionConfig(), null)).isNull();
    }

    @Test
    void prependsExistingSummaryThroughSinglePromptBuilder() {
        List<ChatRequest.Message> messages = service.prependSessionSummary(
                "durable summary", List.of(message(9, "user").chatMessage()));

        assertThat(messages).hasSize(2);
        assertThat(messages.get(0).getRole()).isEqualTo("system");
        assertThat(messages.get(0).getContent().toString()).contains("durable summary");
        assertThat(messages.get(1).getRole()).isEqualTo("user");
    }

    @Test
    void compactLoopSummarizesOlderToolRounds() {
        when(tokenEstimator.estimateMessages(any())).thenReturn(10_000);
        when(tokenEstimator.countTokens("working summary")).thenReturn(10);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>working summary</summary>"));

        AgentEventListener listener = mock(AgentEventListener.class);
        CompactionService.LoopCompactionResult result = service.compactLoop(
                loopConversation(), modelConfig(), loopConfig(), "previous work", listener);

        assertThat(result).isNotNull();
        verify(listener).onCompactionStart("loop", 4, 10_000);
        verify(listener).onCompactionEnd(eq("loop"), eq(10), eq(0), anyLong());
        assertThat(result.summaryText()).isEqualTo("working summary");
        assertThat(result.compactedMessages()).anySatisfy(message ->
                assertThat(message.getContent().toString()).contains("工作记忆摘要"));
    }

    @Test
    void compactLoopReturnsNullWhenNotTriggered() {
        CompactionConfig disabled = loopConfig();
        disabled.setLoopEnabled(false);
        assertThat(service.compactLoop(loopConversation(), modelConfig(), disabled, null)).isNull();

        when(tokenEstimator.estimateMessages(any())).thenReturn(1);
        assertThat(service.compactLoop(loopConversation(), modelConfig(), loopConfig(), null)).isNull();
    }

    private void triggerCompaction(String summary) {
        when(tokenEstimator.estimateMessages(any())).thenReturn(10_000);
        when(tokenEstimator.countTokens(any())).thenReturn(10);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>" + summary + "</summary>"));
    }

    private PersistedChatMessage message(long id, String role) {
        ChatRequest.Message message = ChatRequest.Message.builder()
                .role(role)
                .content(role + " " + id + " ".repeat(20))
                .build();
        if ("assistant".equals(role) && id == 4) {
            message.setToolCalls(List.of(toolCall("call-a"), toolCall("call-b")));
        }
        if ("tool".equals(role)) {
            message.setToolCallId(id == 2 ? "call-a" : "call-b");
        }
        return new PersistedChatMessage(id, message);
    }

    private List<Long> ids(List<PersistedChatMessage> messages) {
        return messages.stream().map(PersistedChatMessage::messageId).sorted().toList();
    }

    private List<ChatRequest.Message> loopConversation() {
        List<ChatRequest.Message> messages = new ArrayList<>();
        messages.add(ChatRequest.Message.builder().role("user").content("do work").build());
        for (int i = 0; i < 4; i++) {
            messages.add(ChatRequest.Message.builder()
                    .role("assistant")
                    .content("calling")
                    .toolCalls(List.of(toolCall("call-" + i)))
                    .build());
            messages.add(ChatRequest.Message.builder()
                    .role("tool")
                    .toolCallId("call-" + i)
                    .content("tool result " + i + " ".repeat(50))
                    .build());
        }
        return messages;
    }

    private ChatRequest.ToolCall toolCall(String id) {
        return ChatRequest.ToolCall.builder()
                .id(id)
                .function(ChatRequest.FunctionCall.builder()
                        .name("read_file").arguments("{\"path\":\"a\"}").build())
                .build();
    }

    private ChatResponse summaryResponse(String content) {
        return ChatResponse.builder()
                .choices(List.of(ChatResponse.Choice.builder()
                        .message(ChatRequest.Message.builder().role("assistant").content(content).build())
                        .build()))
                .usage(ChatUsage.builder().promptTokens(12).completionTokens(4).totalTokens(16).build())
                .build();
    }

    private LlmModelConfig modelConfig() {
        return LlmModelConfig.builder().id(2L).modelId("gpt-test").contextWindowTokens(100).build();
    }

    private CompactionConfig aggressiveSessionConfig() {
        CompactionConfig config = new CompactionConfig();
        config.setEnabled(true);
        config.setContextWindowTokens(100);
        config.setTriggerRatio(0.1);
        config.setRecentTurns(1);
        config.setMinCompactMessageCount(1);
        config.setMinNewMessageCount(1);
        config.setMaxCompactionBatchMessages(20);
        config.setMaxRoundsPerRequest(3);
        return config;
    }

    private CompactionConfig loopConfig() {
        CompactionConfig config = new CompactionConfig();
        config.setLoopEnabled(true);
        config.setLoopTriggerTokens(10);
        config.setLoopRecentToolRounds(1);
        return config;
    }
}
