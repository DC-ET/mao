package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.harness.llm.LlmAdapter;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.SessionCompactionMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class CompactionServiceTest {

    private final LlmAdapter llmAdapter = mock(LlmAdapter.class);
    private final TokenEstimator tokenEstimator = mock(TokenEstimator.class);
    private final SessionCompactionMapper sessionCompactionMapper = mock(SessionCompactionMapper.class);
    private final CompactionService service = new CompactionService(llmAdapter, tokenEstimator, sessionCompactionMapper);

    @Test
    void compactSessionCreatesSummaryRecordAndKeepsRecentMessages() {
        when(sessionCompactionMapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        when(tokenEstimator.estimateMessages(any())).thenReturn(10_000);
        when(tokenEstimator.countTokens("summary text")).thenReturn(20);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>summary text</summary>"));

        CompactionService.SessionCompactionResult result = service.compactSession(
                3L, conversation(12), modelConfig(), aggressiveSessionConfig(), "current question");

        assertThat(result).isNotNull();
        assertThat(result.summaryText()).isEqualTo("summary text");
        assertThat(result.compactedMessages()).hasSize(5);
        assertThat(result.compactedMessages().get(0).getRole()).isEqualTo("system");
        assertThat(result.compactedMessages().get(0).getContent().toString()).contains("summary text");
        assertThat(result.compactedCount()).isEqualTo(8);
        verify(sessionCompactionMapper).insert(any(SessionCompaction.class));
    }

    @Test
    void compactSessionUpdatesExistingRecordAndUsesPlainSummaryWhenTagsAreAbsent() {
        SessionCompaction record = new SessionCompaction();
        record.setId(8L);
        record.setSessionId(3L);
        record.setLastCompactedMsgId(0L);
        record.setCompactCount(2);
        record.setInputTokens(1L);
        record.setOutputTokens(1L);
        record.setSummaryText("old");
        when(sessionCompactionMapper.selectOne(any(QueryWrapper.class))).thenReturn(record);
        when(tokenEstimator.estimateMessages(any())).thenReturn(20_000);
        when(tokenEstimator.countTokens("plain summary")).thenReturn(10);
        when(llmAdapter.chat(any(), eq(modelConfig()))).thenReturn(summaryResponse("plain summary"));

        CompactionService.SessionCompactionResult result = service.compactSession(
                3L, conversation(10), modelConfig(), aggressiveSessionConfig(), null);

        assertThat(result.summaryText()).isEqualTo("plain summary");
        verify(sessionCompactionMapper).updateById(record);
        assertThat(record.getCompactModel()).isEqualTo("gpt-test");
    }

    @Test
    void compactSessionReturnsNullWhenDisabledTooSmallOrLlmFails() {
        CompactionConfig disabled = aggressiveSessionConfig();
        disabled.setEnabled(false);
        assertThat(service.compactSession(1L, conversation(8), modelConfig(), disabled, null)).isNull();

        CompactionConfig enabled = aggressiveSessionConfig();
        assertThat(service.compactSession(1L, List.of(), modelConfig(), enabled, null)).isNull();

        when(sessionCompactionMapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        when(tokenEstimator.estimateMessages(any())).thenReturn(20_000);
        when(llmAdapter.chat(any(), any())).thenReturn(null);
        assertThat(service.compactSession(1L, conversation(8), modelConfig(), enabled, null)).isNull();
    }

    @Test
    void compactLoopSummarizesOlderToolRounds() {
        when(tokenEstimator.estimateMessages(any())).thenReturn(10_000);
        when(tokenEstimator.countTokens("working summary")).thenReturn(10);
        when(llmAdapter.chat(any(), any())).thenReturn(summaryResponse("<summary>working summary</summary>"));

        CompactionService.LoopCompactionResult result = service.compactLoop(
                loopConversation(), modelConfig(), loopConfig(), "previous work");

        assertThat(result).isNotNull();
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

    private List<ChatRequest.Message> conversation(int count) {
        List<ChatRequest.Message> messages = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            messages.add(ChatRequest.Message.builder()
                    .role(i % 2 == 0 ? "user" : "assistant")
                    .content("message " + i + " ".repeat(20))
                    .build());
        }
        return messages;
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
                .function(ChatRequest.FunctionCall.builder().name("read_file").arguments("{\"path\":\"a\"}").build())
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
        config.setRecentTurns(2);
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
