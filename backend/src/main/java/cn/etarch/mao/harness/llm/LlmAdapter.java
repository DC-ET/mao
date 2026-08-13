package cn.etarch.mao.harness.llm;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * LLM 统一调用适配接口
 */
public interface LlmAdapter {

    /**
     * 同步调用 LLM
     */
    ChatResponse chat(ChatRequest request, LlmModelConfig config);

    /**
     * 可取消的同步调用。默认实现保持既有调用方与测试适配器兼容。
     */
    default ChatResponse chat(ChatRequest request, LlmModelConfig config, AtomicBoolean cancelFlag) {
        if (cancelFlag != null && cancelFlag.get()) {
            throw new RuntimeException("Cancelled by user");
        }
        return chat(request, config);
    }

    /**
     * 流式调用 LLM
     *
     * @param cancelFlag 取消标志，设为 true 时实现应尽快中断流式响应
     */
    void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback, AtomicBoolean cancelFlag);
}
