package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.harness.llm")
public class LlmRetryConfig {

    /** 瞬时错误（429 限流、5xx 服务端错误，含 524 网关超时）最大重试次数 */
    private int rateLimitMaxRetries = 10;

    /**
     * 指数退避基间隔（秒）：第 n 次重试前等待 base * 2^(n-1) 秒
     * （第 1 次等 base，第 2 次等 2*base，第 3 次等 4*base，以此类推）
     */
    private int rateLimitRetryDelaySeconds = 1;

    /** 单次重试间隔上限（秒），指数退避与 Retry-After 均不超过该值 */
    private int rateLimitMaxRetryDelaySeconds = 60;

    /**
     * 应用层 LLM 调用硬超时（秒）：等待响应头（stream 的 awaitResponse）与同步调用（chat）的整体上限。
     * OkHttp 内部超时（readTimeout / writeTimeout）依赖 Okio Watchdog 关闭底层 Socket，
     * 极端场景下（SSL 读写被锁阻塞，如代理/负载均衡静默断连）Watchdog 关闭 Socket 也会被同一把锁卡住，
     * 导致内部超时全部失效。到达该时长后由应用层主动取消请求并报错兜底（默认 10 分钟）。
     */
    private int callTimeoutSeconds = 600;

    /**
     * OkHttp callTimeout（秒）：整个调用（connect + write + 含流式读取响应体）的总预算，
     * 应大于等于正常单次流式响应的整体时长（默认 15 分钟）。
     */
    private int httpCallTimeoutSeconds = 900;
}
