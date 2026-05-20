package com.agentworkbench.harness.llm;

/**
 * LLM 流式调用回调接口
 */
public interface StreamCallback {

    void onChunk(StreamChunk chunk);

    void onComplete(ChatUsage usage);

    void onError(Throwable t);
}
