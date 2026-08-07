package cn.etarch.mao.harness.llm;

/**
 * LLM 流式调用回调接口
 */
public interface StreamCallback {

    void onChunk(StreamChunk chunk);

    void onComplete(ChatUsage usage);

    void onError(Throwable t);

    /**
     * LLM 请求遇到瞬时错误（429 限流 / 5xx 服务端错误）即将进入重试前回调，
     * 用于让调用方把重试进度透传给客户端。
     *
     * @param statusCode   触发重试的 HTTP 状态码
     * @param attempt      当前第几次尝试（含首次失败的那次）
     * @param maxRetries   最大重试次数
     * @param delaySeconds 本次重试前等待的秒数
     */
    default void onRetry(int statusCode, int attempt, int maxRetries, int delaySeconds) {
    }
}
