package com.agentworkbench.harness.delegate;

import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

/**
 * 子智能体事件监听器，负责收集最终结果。
 * 只保留最后一个 assistant 消息的文本内容，丢弃中间过程。
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

    @Override
    public void onContentDelta(String delta) {
        contentBuilder.append(delta);
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        toolCallCount++;
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
        thinkingBuilder.append(delta);
    }

    /**
     * 获取子智能体最终文本输出
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
