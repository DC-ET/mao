package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class CompositeAgentEventListenerTest {

    @Test
    void fansOutToAllListeners() {
        List<String> a = new ArrayList<>();
        List<String> b = new ArrayList<>();
        AgentEventListener first = recording(a);
        AgentEventListener second = recording(b);

        CompositeAgentEventListener composite = new CompositeAgentEventListener(first, second);
        composite.onThinkingStart();
        composite.onContentDelta("hello");
        composite.onToolCallStart(ChatRequest.ToolCall.builder()
                .id("c1")
                .function(ChatRequest.FunctionCall.builder().name("read_file").arguments("{}").build())
                .build());
        composite.onToolCallResult("c1", "{}");
        composite.onMessageEnd(ChatUsage.builder().totalTokens(3).build());

        assertThat(a).containsExactly(
                "thinkingStart", "delta:hello", "toolStart:c1", "toolResult:c1", "messageEnd");
        assertThat(b).containsExactly(
                "thinkingStart", "delta:hello", "toolStart:c1", "toolResult:c1", "messageEnd");
    }

    @Test
    void continuesWhenOneListenerThrows() {
        AtomicInteger okCalls = new AtomicInteger();
        AgentEventListener broken = new AgentEventListener() {
            @Override
            public void onContentDelta(String delta) {
                throw new RuntimeException("boom");
            }

            @Override
            public void onToolCallStart(ChatRequest.ToolCall toolCall) {}

            @Override
            public void onToolCallResult(String toolCallId, String result) {}

            @Override
            public void onMessageEnd(ChatUsage usage) {}

            @Override
            public void onError(Throwable t) {}
        };
        AgentEventListener ok = new AgentEventListener() {
            @Override
            public void onContentDelta(String delta) {
                okCalls.incrementAndGet();
            }

            @Override
            public void onToolCallStart(ChatRequest.ToolCall toolCall) {}

            @Override
            public void onToolCallResult(String toolCallId, String result) {}

            @Override
            public void onMessageEnd(ChatUsage usage) {}

            @Override
            public void onError(Throwable t) {}
        };

        new CompositeAgentEventListener(broken, ok).onContentDelta("x");
        assertThat(okCalls.get()).isEqualTo(1);
    }

    @Test
    void ignoresNullListeners() {
        List<String> events = new ArrayList<>();
        new CompositeAgentEventListener(null, recording(events)).onContentDelta("z");
        assertThat(events).containsExactly("delta:z");
    }

    private static AgentEventListener recording(List<String> sink) {
        return new AgentEventListener() {
            @Override
            public void onContentDelta(String delta) {
                sink.add("delta:" + delta);
            }

            @Override
            public void onToolCallStart(ChatRequest.ToolCall toolCall) {
                sink.add("toolStart:" + toolCall.getId());
            }

            @Override
            public void onToolCallResult(String toolCallId, String result) {
                sink.add("toolResult:" + toolCallId);
            }

            @Override
            public void onMessageEnd(ChatUsage usage) {
                sink.add("messageEnd");
            }

            @Override
            public void onError(Throwable t) {
                sink.add("error");
            }

            @Override
            public void onThinkingStart() {
                sink.add("thinkingStart");
            }
        };
    }
}
