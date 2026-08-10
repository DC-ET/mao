package cn.etarch.mao.harness.llm;

/**
 * LLM 流式调用回调接口
 */
public interface StreamCallback {

    void onChunk(StreamChunk chunk);

    void onComplete(ChatUsage usage);

    void onError(Throwable t);

    /** 等待网络阶段的周期通知。phase 当前为 response_headers 或 stream_data。 */
    default void onWaiting(String phase, long elapsedSeconds) {
    }

    /**
     * LLM 请求遇到可恢复网络错误即将进入重试前回调。
     * 默认转发到旧重载，兼容已有调用方。
     */
    default void onRetry(String reason, Integer statusCode, int attempt,
                         int maxRetries, int delaySeconds) {
        onRetry(statusCode != null ? statusCode : 0, attempt, maxRetries, delaySeconds);
    }

    /**
     * @deprecated 请实现带 reason 的重载；保留用于兼容已有调用方。
     */
    @Deprecated
    default void onRetry(int statusCode, int attempt, int maxRetries, int delaySeconds) {
    }
}
