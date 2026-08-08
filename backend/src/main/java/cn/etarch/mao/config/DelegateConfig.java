package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * 子代理（delegate）执行配置。
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.harness.delegate")
public class DelegateConfig {

    /**
     * 子代理整体执行超时（秒）。超时后置位子代理取消标志请求其退出，
     * 避免子代理 LLM 请求卡死（如 SSL 写阻塞导致 OkHttp 超时机制失效）时无限拖住父 Agent（默认 15 分钟）。
     */
    private int timeoutSeconds = 900;

    /**
     * 超时后等待子代理响应取消并退出的宽限期（秒）。
     * 宽限期后仍卡死则放弃等待、直接标记子代理失败并返回父 Agent（默认 30 秒）。
     */
    private int cancelGraceSeconds = 30;
}
