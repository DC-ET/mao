package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SubAgentResultCollectorTest {

    @Test
    void keepsOnlyLastSynthesisRoundDiscardingToolRoundText() {
        SubAgentResultCollector collector = new SubAgentResultCollector();

        collector.onThinkingStart();
        collector.onContentDelta("先查一下文件…");
        collector.onToolCallStart(ChatRequest.ToolCall.builder()
                .id("call-1")
                .function(ChatRequest.FunctionCall.builder().name("read_file").arguments("{}").build())
                .build());
        collector.onToolCallResult("call-1", "{\"ok\":true}");

        collector.onThinkingStart();
        collector.onContentDelta("结论：文件存在。");
        collector.onMessageEnd(ChatUsage.builder().totalTokens(10).build());

        assertThat(collector.getResult()).isEqualTo("结论：文件存在。");
        assertThat(collector.getToolCallCount()).isEqualTo(1);
        assertThat(collector.isCompleted()).isTrue();
    }

    @Test
    void thinkingStartResetsPreviousAssistantText() {
        SubAgentResultCollector collector = new SubAgentResultCollector();

        collector.onThinkingStart();
        collector.onContentDelta("第一轮草稿");
        collector.onThinkingStart();
        collector.onContentDelta("第二轮定稿");

        assertThat(collector.getResult()).isEqualTo("第二轮定稿");
    }

    @Test
    void toolCallClearsContentEvenWithoutFollowingRound() {
        SubAgentResultCollector collector = new SubAgentResultCollector();

        collector.onThinkingStart();
        collector.onContentDelta("中间说明");
        collector.onToolCallStart(ChatRequest.ToolCall.builder()
                .id("call-2")
                .function(ChatRequest.FunctionCall.builder().name("shell").arguments("{}").build())
                .build());

        assertThat(collector.getResult()).isEmpty();
    }
}
