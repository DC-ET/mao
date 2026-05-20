package com.agentworkbench.harness.llm;

/**
 * LLM 统一调用适配接口
 */
public interface LlmAdapter {

    /**
     * 同步调用 LLM
     */
    ChatResponse chat(ChatRequest request, LlmModelConfig config);

    /**
     * 流式调用 LLM
     */
    void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback);
}
