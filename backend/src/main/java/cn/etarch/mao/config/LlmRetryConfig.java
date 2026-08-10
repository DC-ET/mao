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
    private int rateLimitRetryDelaySeconds = 2;

    /** 单次重试间隔上限（秒），指数退避与 Retry-After 均不超过该值 */
    private int rateLimitMaxRetryDelaySeconds = 30;

    /**
     * 等待 LLM 响应头（首包）的应用层超时（秒）。
     * 保留原配置名以兼容现有部署；流式响应头到达后不再受此超时限制。
     */
    private int callTimeoutSeconds = 120;

    /** OkHttp 单次 HTTP 调用总超时（秒，包含连接、写入和流式读取）。 */
    private int httpCallTimeoutSeconds = 180;

    /** 流式响应连续无任何 SSE 数据的读取超时（秒）。 */
    private int streamIdleTimeoutSeconds = 120;
}
