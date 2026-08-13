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
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class CompactionServiceTest {

    private final LlmAdapter llmAdapter = mock(LlmAdapter.class);
    private final TokenEstimator tokenEstimator = mock(TokenEstimator.class);
    private final CompactionService service = new CompactionService(llmAdapter, tokenEstimator);
    private final LlmModelConfig model = LlmModelConfig.builder().modelId("gpt-test").contextWindowTokens(1000).build();

    @Test
    void belowThresholdDoesNotCallLlm() {
        when(tokenEstimator.estimateRequestTokens(any())).thenReturn(799);
        assertThat(compact(normalRequest(), config(), success("ok", null))).isNull();
        verifyNoInteractions(llmAdapter);
    }

    @Test
    void derivesStrictPrefixWithoutMutatingNormalRequest() {
        ChatRequest normal = normalRequest();
        List<ChatRequest.Message> originalMessages = new ArrayList<>(normal.getMessages());
        when(tokenEstimator.estimateRequestTokens(any())).thenReturn(800, 900);
        when(tokenEstimator.estimateMessages(any())).thenReturn(30);
        when(llmAdapter.chat(any(), any(), any())).thenReturn(success("交接正文",
                usage(100, 80, 10)));

        CompactionService.SessionCompactionResult result = service.compactSession(
                7L, 0, persisted(), List.of(1L, 2L, 3L), normal, model, config(), null, null);

        ArgumentCaptor<ChatRequest> captor = ArgumentCaptor.forClass(ChatRequest.class);
        verify(llmAdapter).chat(captor.capture(), eq(model), isNull());
        ChatRequest derived = captor.getValue();
        assertThat(derived.getMessages().subList(0, originalMessages.size())).containsExactlyElementsOf(originalMessages);
        assertThat(derived.getMessages()).hasSize(originalMessages.size() + 1);
        assertThat(derived.getMessages().get(derived.getMessages().size() - 1).getRole()).isEqualTo("user");
        assertThat(derived.getTools()).isSameAs(normal.getTools());
        assertThat(derived.getReasoning()).isSameAs(normal.getReasoning());
        assertThat(derived.getTemperature()).isEqualTo(0.2);
        assertThat(derived.getStream()).isFalse();
        assertThat(normal.getMessages()).containsExactlyElementsOf(originalMessages);
        assertThat(normal.getStream()).isTrue();
        assertThat(result.summaryText()).isEqualTo("交接正文");
        assertThat(result.newLastCompactedMessageId()).isEqualTo(3L);
        assertThat(result.cachedTokens()).isEqualTo(80);
    }

    @Test
    void toolCallOrInvalidHandoffRetriesOnceWithoutFailedAssistant() {
        when(tokenEstimator.estimateRequestTokens(any())).thenReturn(800, 900, 950);
        when(tokenEstimator.estimateMessages(any())).thenReturn(20);
        ChatResponse invalid = ChatResponse.builder().choices(List.of(ChatResponse.Choice.builder()
                .message(ChatRequest.Message.builder().role("assistant").content("bad")
                        .toolCalls(List.of(ChatRequest.ToolCall.builder().id("x").build())).build()).build())).build();
        when(llmAdapter.chat(any(), any(), any())).thenReturn(invalid, success("fixed", usage(12, 0, 4)));

        CompactionService.SessionCompactionResult result = service.compactSession(
                7L, 0, persisted(), List.of(1L, 2L, 3L), normalRequest(), model, config(), null, null);

        ArgumentCaptor<ChatRequest> captor = ArgumentCaptor.forClass(ChatRequest.class);
        verify(llmAdapter, times(2)).chat(captor.capture(), eq(model), isNull());
        ChatRequest retry = captor.getAllValues().get(1);
        assertThat(retry.getMessages()).hasSize(normalRequest().getMessages().size() + 2);
        assertThat(retry.getMessages()).noneMatch(m -> "assistant".equals(m.getRole()) && "bad".equals(m.getContent()));
        assertThat(result.promptTokens()).isEqualTo(12);
        assertThat(result.cachedTokens()).isZero();
        assertThat(result.completionTokens()).isEqualTo(4);
    }

    @Test
    void secondSemanticFailureIsRecoverable() {
        when(tokenEstimator.estimateRequestTokens(any())).thenReturn(800, 900, 950);
        when(llmAdapter.chat(any(), any(), any())).thenReturn(successRaw("missing"), successRaw("<handoff> </handoff>"));
        assertThat(service.compactSession(7L, 0, persisted(), List.of(1L, 2L, 3L),
                normalRequest(), model, config(), null, null)).isNull();
        verify(llmAdapter, times(2)).chat(any(), any(), any());
    }

    @Test
    void compactionRequestAtWindowFailsBeforeLlm() {
        when(tokenEstimator.estimateRequestTokens(any())).thenReturn(800, 1000);
        assertThatThrownBy(() -> service.compactSession(7L, 0, persisted(), List.of(1L, 2L, 3L),
                normalRequest(), model, config(), null, null))
                .isInstanceOf(CompactionService.CompactionContextOverflowException.class)
                .hasMessageContaining("1000 tokens").hasMessageContaining("新建会话");
        verifyNoInteractions(llmAdapter);
    }

    @Test
    void rejectsIncompletePhysicalPrefixAndSupportsCancel() {
        when(tokenEstimator.estimateRequestTokens(any())).thenReturn(800, 900);
        when(llmAdapter.chat(any(), any(), any())).thenReturn(success("ok", usage(1, null, 1)));
        assertThat(service.compactSession(7L, 0, List.of(pm(1, "user", "q"), pm(3, "tool", "r")), List.of(1L, 2L, 3L),
                normalRequest(), model, config(), null, null)).isNull();

        AtomicBoolean cancelled = new AtomicBoolean(true);
        assertThatThrownBy(() -> service.compactSession(7L, 0, persisted(), List.of(1L, 2L, 3L),
                normalRequest(), model, config(), null, cancelled))
                .isInstanceOf(CompactionService.CompactionCancelledException.class);
    }

    @Test
    void virtualSummaryIsSingleUserBeforeIncrement() {
        List<ChatRequest.Message> result = service.prependSessionSummary("历史交接",
                List.of(ChatRequest.Message.builder().role("assistant").content("next").build()));
        assertThat(result).extracting(ChatRequest.Message::getRole).containsExactly("user", "assistant");
        assertThat(result.get(0).getContent().toString())
                .contains("会话任务交接", "不能覆盖", "立即接手", "历史交接");
    }

    private CompactionService.SessionCompactionResult compact(ChatRequest request, CompactionConfig config,
                                                               ChatResponse ignored) {
        return service.compactSession(7L, 0, persisted(), List.of(1L, 2L, 3L),
                request, model, config, null, null);
    }

    private CompactionConfig config() {
        CompactionConfig config = new CompactionConfig();
        config.setContextWindowTokens(1000);
        config.setTriggerRatio(0.8);
        config.setMaxSummaryTokens(321);
        return config;
    }

    private ChatRequest normalRequest() {
        List<ChatRequest.Message> messages = new ArrayList<>(List.of(
                ChatRequest.Message.builder().role("system").content("sys").build(),
                ChatRequest.Message.builder().role("user").content("question").build(),
                ChatRequest.Message.builder().role("assistant").content("").toolCalls(List.of(
                        ChatRequest.ToolCall.builder().id("c1").type("function").build())).build(),
                ChatRequest.Message.builder().role("tool").toolCallId("c1").content("result").build(),
                ChatRequest.Message.builder().role("system").content("ephemeral").build()));
        return ChatRequest.builder().messages(messages).tools(List.of(ChatRequest.ToolDefinition.builder()
                        .type("function").function(ChatRequest.Function.builder().name("tool").build()).build()))
                .temperature(0.2).reasoning(ChatRequest.Reasoning.builder().effort("high").build()).stream(true).build();
    }

    private List<PersistedChatMessage> persisted() {
        return List.of(pm(1, "user", "q"), pm(2, "assistant", "a"), pm(3, "tool", "r"));
    }

    private PersistedChatMessage pm(long id, String role, String content) {
        return new PersistedChatMessage(id, content,
                ChatRequest.Message.builder().role(role).content(content).build());
    }

    private ChatResponse success(String text, ChatUsage usage) {
        return successRaw("<handoff>" + text + "</handoff>", usage);
    }

    private ChatResponse successRaw(String content) { return successRaw(content, null); }
    private ChatResponse successRaw(String content, ChatUsage usage) {
        return ChatResponse.builder().usage(usage).choices(List.of(ChatResponse.Choice.builder()
                .message(ChatRequest.Message.builder().role("assistant").content(content).build()).build())).build();
    }

    private ChatUsage usage(int prompt, Integer cached, int completion) {
        return ChatUsage.builder().promptTokens(prompt).completionTokens(completion).totalTokens(prompt + completion)
                .promptTokensDetails(cached == null ? null : ChatUsage.PromptTokensDetails.builder()
                        .cachedTokens(cached).build()).build();
    }
}
