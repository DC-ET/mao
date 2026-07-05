package com.agentworkbench.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.harness.llm")
public class LlmRetryConfig {

    /** 429 限流时最大重试次数 */
    private int rateLimitMaxRetries = 10;

    /** 429 限流时每次重试前等待秒数（未提供 Retry-After 响应头时使用） */
    private int rateLimitRetryDelaySeconds = 5;
}
