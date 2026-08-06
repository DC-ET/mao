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

    /** 瞬时错误每次重试前等待秒数（未提供 Retry-After 响应头时使用） */
    private int rateLimitRetryDelaySeconds = 5;
}
