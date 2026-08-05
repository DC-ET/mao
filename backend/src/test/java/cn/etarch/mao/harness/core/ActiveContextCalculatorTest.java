package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ActiveContextCalculatorTest {

    private final ActiveContextCalculator calculator =
            new ActiveContextCalculator(new TokenEstimator(new ObjectMapper()));

    @Test
    void usesAnchorPlusDeltaWhenValid() {
        ChatRequest.Message delta = ChatRequest.Message.builder()
                .role("assistant")
                .content("abcd") // 1 token by bytes/4
                .build();
        int active = calculator.active(100, 10L, List.of(delta), null);
        assertThat(active).isEqualTo(100 + calculator.estimateMessages(List.of(delta)));
    }

    @Test
    void fallsBackToFullRequestWithoutAnchor() {
        ChatRequest.Message msg = ChatRequest.Message.builder()
                .role("user")
                .content("hello")
                .build();
        ChatRequest request = ChatRequest.builder().messages(List.of(msg)).build();
        int active = calculator.active(0, 0L, null, request);
        assertThat(active).isEqualTo(calculator.estimateRequestTokens(request));
    }

    @Test
    void activeFromMessageSuffixUsesCoveredCount() {
        ChatRequest.Message a = ChatRequest.Message.builder().role("user").content("aa").build();
        ChatRequest.Message b = ChatRequest.Message.builder().role("assistant").content("bbbb").build();
        List<ChatRequest.Message> all = List.of(a, b);
        int active = calculator.activeFromMessageSuffix(50, 9L, all, 1, null);
        assertThat(active).isEqualTo(50 + calculator.estimateMessages(List.of(b)));
    }

    @Test
    void activeFromMessageSuffixIncludesMessagesAddedAfterCoveredIndex() {
        // Mirrors AgentLoop: capture size before LLM, then append assistant + tool after complete.
        ChatRequest.Message user = ChatRequest.Message.builder().role("user").content("question").build();
        ChatRequest.Message assistant = ChatRequest.Message.builder()
                .role("assistant").content("calling tool").build();
        ChatRequest.Message tool = ChatRequest.Message.builder()
                .role("tool").toolCallId("c1").content("tool result payload").build();
        int coveredBeforeLlm = 1;
        List<ChatRequest.Message> afterTools = List.of(user, assistant, tool);

        int active = calculator.activeFromMessageSuffix(1000, 42L, afterTools, coveredBeforeLlm, null);

        assertThat(active).isEqualTo(1000 + calculator.estimateMessages(List.of(assistant, tool)));
        assertThat(active).isGreaterThan(1000);
    }

    @Test
    void activeFromMessageSuffixFallsBackWhenCoveredUnset() {
        ChatRequest.Message msg = ChatRequest.Message.builder().role("user").content("x").build();
        ChatRequest request = ChatRequest.builder().messages(List.of(msg)).build();
        // No in-memory covered index, but DB anchor may already be valid after ensureContextAnchorLoaded
        int active = calculator.activeFromMessageSuffix(500, 9L, List.of(msg), -1, request);
        assertThat(active).isEqualTo(calculator.estimateRequestTokens(request));
        assertThat(active).isNotEqualTo(500); // must not drop delta to empty
    }
}
