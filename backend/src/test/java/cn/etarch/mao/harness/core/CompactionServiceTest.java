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
    void borrowsRetainedTurnsToReachTargetWatermark() {
        // 每条消息估算 100 token，summary 10 token；contextWindow=100 × targetRatio=0.25 → 目标 25
        when(tokenEstimator.estimateMessages(any())).thenAnswer(inv -> {
            List<?> msgs = inv.getArgument(0);
            return msgs.size() * 100;
        });
        when(tokenEstimator.countTokens(any())).thenReturn(10);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>merged</summary>"));
        CompactionConfig config = aggressiveSessionConfig();
        config.setRecentTurns(4);
        config.setMinRetainedTurns(2);

        // 6 个完整轮次 + 当前轮；候选为最早 2 轮，压完后水位仍超目标，需依次借入保留的第 3、4 轮
        List<PersistedChatMessage> messages = List.of(
                message(1, "user"), message(2, "assistant"),
                message(3, "user"), message(4, "assistant"),
                message(5, "user"), message(6, "assistant"),
                message(7, "user"), message(8, "assistant"),
                message(9, "user"), message(10, "assistant"),
                message(11, "user"), message(12, "assistant"),
                message(20, "user"));

        var result = service.compactSession(
                1L, 0, null, messages, ids(messages), modelConfig(), config, null);

        assertThat(result).isNotNull();
        assertThat(result.newLastCompactedMessageId()).isEqualTo(8L);
        assertThat(result.compactedCount()).isEqualTo(8);
        verify(llmAdapter, times(3)).chat(any(), any());
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
    void prependSessionSummaryAddsSyntheticUserWhenIncrementStartsWithAssistant() {
        List<ChatRequest.Message> messages = service.prependSessionSummary(
                "summary",
                List.of(ChatRequest.Message.builder().role("assistant").content("cont").build()));

        assertThat(messages).extracting(ChatRequest.Message::getRole)
                .containsExactly("system", "user", "assistant");
        assertThat(messages.get(1).getContent().toString()).contains("历史压缩摘要");
    }

    @Test
    void prependSessionSummaryDoesNotAddSyntheticUserWhenStartsWithUser() {
        List<ChatRequest.Message> messages = service.prependSessionSummary(
                "summary",
                List.of(ChatRequest.Message.builder().role("user").content("hi").build()));

        assertThat(messages).extracting(ChatRequest.Message::getRole)
                .containsExactly("system", "user");
    }

    @Test
    void prependSessionSummaryDoesNotAddSyntheticUserWithoutSummary() {
        List<ChatRequest.Message> messages = service.prependSessionSummary(
                null,
                List.of(ChatRequest.Message.builder().role("assistant").content("cont").build()));

        assertThat(messages).extracting(ChatRequest.Message::getRole)
                .containsExactly("assistant");
    }

    @Test
    void loopModeCompactsContinuousPrefixIncludingCurrentTurnHead() {
        triggerCompaction("loop summary");
        CompactionConfig config = loopMidwayConfig();
        config.setLoopRecentToolRounds(1);
        config.setLoopMaxCompactionRounds(5);
        config.setMaxCompactionBatchMessages(200);

        // history turn + current turn with 3 tool rounds → compact history + USER + first 2 rounds
        List<PersistedChatMessage> messages = loopModeMessages();

        AgentEventListener listener = mock(AgentEventListener.class);
        var result = service.compactSession(
                3L, 0, null, messages, ids(messages),
                modelConfig(), config, "do the task", listener, true, 10_000);

        assertThat(result).isNotNull();
        verify(listener).onCompactionStart(eq("session"), any(Integer.class), any(Integer.class));
        verify(listener).onCompactionEnd(eq("session"), any(Integer.class), any(Integer.class), anyLong());
        // Boundary at end of second tool round in current turn (msg 50 = last tool of round 2)
        assertThat(result.newLastCompactedMessageId()).isEqualTo(50L);
        assertThat(result.summaryText()).isEqualTo("loop summary");

        ArgumentCaptor<ChatRequest> requestCaptor = ArgumentCaptor.forClass(ChatRequest.class);
        verify(llmAdapter).chat(requestCaptor.capture(), any());
        String prompt = requestCaptor.getValue().getMessages().get(0).getContent().toString();
        assertThat(prompt).contains("当前用户问题", "do the task", "原文完整保留");
    }

    @Test
    void loopModeDoesNotEnterCurrentTurnWhenToolRoundsWithinKeepLimit() {
        triggerCompaction("only history");
        CompactionConfig config = loopMidwayConfig();
        config.setLoopRecentToolRounds(5);

        List<PersistedChatMessage> messages = List.of(
                message(1, "user"), message(2, "assistant"),
                message(10, "user"),
                assistantWithTools(20, "c1"),
                toolMsg(21, "c1"),
                assistantWithTools(30, "c2"),
                toolMsg(31, "c2"));

        var result = service.compactSession(
                1L, 0, null, messages, ids(messages),
                modelConfig(), config, "q", null, true, 10_000);

        assertThat(result).isNotNull();
        // Only history turn compacted; current turn has 2 rounds <= 5 keep
        assertThat(result.newLastCompactedMessageId()).isEqualTo(2L);
    }

    @Test
    void loopModeKeepsParallelToolCallsInSameUnit() {
        when(tokenEstimator.estimateMessages(any())).thenAnswer(inv -> {
            List<?> msgs = inv.getArgument(0);
            return msgs.size() * 100;
        });
        when(tokenEstimator.countTokens(any())).thenReturn(10);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>parallel</summary>"));
        CompactionConfig config = loopMidwayConfig();
        config.setLoopRecentToolRounds(1);
        config.setMaxCompactionBatchMessages(2); // smaller than 1 assistant + 3 tools
        config.setTargetRatio(0.01); // keep compressing past first (USER-only) batch

        List<PersistedChatMessage> messages = List.of(
                message(1, "user"),
                assistantWithTools(10, "a", "b", "c"),
                toolMsg(11, "a"),
                toolMsg(12, "b"),
                toolMsg(13, "c"),
                assistantWithTools(20, "d"),
                toolMsg(21, "d"));

        var result = service.compactSession(
                1L, 0, null, messages, ids(messages),
                modelConfig(), config, "q", null, true, 10_000);

        assertThat(result).isNotNull();
        // First tool round (10-13) compacted as one intact unit (not split mid-round)
        assertThat(result.newLastCompactedMessageId()).isEqualTo(13L);
        assertThat(result.compactedCount()).isEqualTo(5); // user + assistant + 3 tools
        // USER unit then parallel tool-round unit → 2 LLM rounds, unit never split
        verify(llmAdapter, times(2)).chat(any(), any());
    }

    @Test
    void loopModeIgnoresMinMessageCountWhenRequestTokensHigh() {
        triggerCompaction("few msgs");
        CompactionConfig config = loopMidwayConfig();
        config.setMinCompactMessageCount(100);
        config.setMinNewMessageCount(100);
        config.setLoopRecentToolRounds(1);

        List<PersistedChatMessage> messages = List.of(
                message(1, "user"),
                assistantWithTools(10, "a"),
                toolMsg(11, "a"),
                assistantWithTools(20, "b"),
                toolMsg(21, "b"));

        var result = service.compactSession(
                1L, 0, null, messages, ids(messages),
                modelConfig(), config, "q", null, true, 10_000);

        assertThat(result).isNotNull();
        assertThat(result.newLastCompactedMessageId()).isEqualTo(11L);
    }

    @Test
    void loopModeStopsAtMaxCompactionRounds() {
        when(tokenEstimator.estimateMessages(any())).thenReturn(10_000);
        when(tokenEstimator.countTokens(any())).thenReturn(10);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>r</summary>"));
        CompactionConfig config = loopMidwayConfig();
        config.setLoopRecentToolRounds(1);
        config.setLoopMaxCompactionRounds(1);
        config.setMaxCompactionBatchMessages(2);
        config.setTargetRatio(0.01); // never reach watermark

        List<PersistedChatMessage> messages = loopModeMessages();
        var result = service.compactSession(
                1L, 0, null, messages, ids(messages),
                modelConfig(), config, "q", null, true, 10_000);

        assertThat(result).isNotNull();
        verify(llmAdapter, times(1)).chat(any(), any());
    }

    @Test
    void loopModeReturnsNullWhenRequestBelowTrigger() {
        CompactionConfig config = loopMidwayConfig();
        List<PersistedChatMessage> messages = loopModeMessages();
        assertThat(service.compactSession(
                1L, 0, null, messages, ids(messages),
                modelConfig(), config, "q", null, true, 1)).isNull();
    }

    private List<PersistedChatMessage> loopModeMessages() {
        return List.of(
                message(1, "user"), message(2, "assistant"),
                message(10, "user"),
                assistantWithTools(20, "c1"),
                toolMsg(21, "c1"),
                assistantWithTools(40, "c2"),
                toolMsg(50, "c2"),
                assistantWithTools(60, "c3"),
                toolMsg(61, "c3"));
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

    private PersistedChatMessage assistantWithTools(long id, String... callIds) {
        List<ChatRequest.ToolCall> calls = new ArrayList<>();
        for (String callId : callIds) {
            calls.add(toolCall(callId));
        }
        ChatRequest.Message message = ChatRequest.Message.builder()
                .role("assistant")
                .content("calling " + id)
                .toolCalls(calls)
                .build();
        return new PersistedChatMessage(id, message);
    }

    private PersistedChatMessage toolMsg(long id, String callId) {
        return new PersistedChatMessage(id, ChatRequest.Message.builder()
                .role("tool")
                .toolCallId(callId)
                .content("tool result " + id + " ".repeat(20))
                .build());
    }

    private List<Long> ids(List<PersistedChatMessage> messages) {
        return messages.stream().map(PersistedChatMessage::messageId).sorted().toList();
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

    private CompactionConfig loopMidwayConfig() {
        CompactionConfig config = new CompactionConfig();
        config.setEnabled(true);
        config.setLoopMidwayCompact(true);
        config.setContextWindowTokens(100);
        config.setTriggerRatio(0.1);
        config.setTargetRatio(0.25);
        config.setLoopRecentToolRounds(1);
        config.setLoopMaxCompactionRounds(5);
        config.setMaxCompactionBatchMessages(200);
        config.setMaxSummaryTokens(12000);
        return config;
    }
}
