package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;

/**
 * Agent 事件监听器，用于流式推送执行进度
 */
public interface AgentEventListener {

    void onContentDelta(String delta);

    void onToolCallStart(ChatRequest.ToolCall toolCall);

    void onToolCallResult(String toolCallId, String result);

    void onMessageEnd(ChatUsage usage);

    void onError(Throwable t);

    default void onContextCompressed(int messageCount) {
        // optional: notify frontend that context was compressed
    }
}
