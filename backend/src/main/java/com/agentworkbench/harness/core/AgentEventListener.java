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

    /**
     * 上下文窗口大小变更通知
     * @param estimatedTokens 估算 token 数（cl100k_base，快速反馈）
     * @param actualTokens LLM 真实返回的 prompt_tokens（0 表示尚未返回）
     */
    default void onContextWindow(int estimatedTokens, int actualTokens) {}

    /**
     * 压缩开始
     * @param type "session" 或 "loop"
     * @param messageCount 参与压缩的消息数
     * @param estimatedTokens 压缩前估算 token 数
     */
    default void onCompactionStart(String type, int messageCount, int estimatedTokens) {}

    /**
     * 压缩完成
     * @param type "session" 或 "loop"
     * @param summaryTokens 摘要 token 数
     * @param savedTokens 节省的 token 数
     * @param durationMs 压缩耗时（毫秒）
     */
    default void onCompactionEnd(String type, int summaryTokens, int savedTokens, long durationMs) {}

    /** Agent 正在思考（工具执行完毕，等待下一次 LLM 调用期间） */
    default void onThinkingStart() {}

    /** Agent 思考结束（下一次 LLM 开始输出） */
    default void onThinkingEnd() {}

    /** 工具调用参数增量更新（LLM 流式输出 arguments 碎片时，推送当前完整的 arguments） */
    default void onToolCallArgsDelta(String toolCallId, String arguments) {}

    /** 模型思考内容增量（在 content delta 之前到达） */
    default void onThinkingDelta(String delta) {}
}
