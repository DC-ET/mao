package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.core.AgentEventListener;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

/**
 * 子智能体事件监听器，负责收集最终结果。
 * 只保留最后一个无 tool_calls 的 assistant 文本，丢弃中间过程轮次。
 */
@Slf4j
public class SubAgentResultCollector implements AgentEventListener {

    private final StringBuilder contentBuilder = new StringBuilder();
    private final StringBuilder thinkingBuilder = new StringBuilder();

    @Getter
    private ChatUsage totalUsage;

    @Getter
    private volatile boolean completed = false;

    @Getter
    private volatile Throwable error;

    @Getter
    private int toolCallCount = 0;

    /**
     * New LLM round — drop previous-round text so only the latest assistant turn is kept.
     */
    @Override
    public void onThinkingStart() {
        contentBuilder.setLength(0);
        thinkingBuilder.setLength(0);
    }

    @Override
    public void onContentDelta(String delta) {
        if (delta != null) {
            contentBuilder.append(delta);
        }
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        toolCallCount++;
        // Text paired with tool calls is intermediate; final answer comes from a later synthesis round
        contentBuilder.setLength(0);
    }

    @Override
    public void onToolCallResult(String toolCallId, String result) {
        // 子智能体内部工具结果，不转发给主 Agent
    }

    @Override
    public void onMessageEnd(ChatUsage usage) {
        this.totalUsage = usage;
        this.completed = true;
    }

    @Override
    public void onError(Throwable t) {
        this.error = t;
        this.completed = true;
    }

    @Override
    public void onThinkingDelta(String delta) {
        if (delta != null) {
            thinkingBuilder.append(delta);
        }
    }

    /**
     * 获取子智能体最终文本输出（最后一轮无工具调用的 assistant 内容）
     */
    public String getResult() {
        return contentBuilder.toString().trim();
    }

    /**
     * 获取 thinking 内容（用于调试/日志）
     */
    public String getThinkingContent() {
        return thinkingBuilder.length() > 0 ? thinkingBuilder.toString() : null;
    }
}
