package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.harness.tavily")
public class TavilyConfig {

    /** Tavily API Key */
    private String apiKey = "";

    /** Tavily API Base URL */
    private String baseUrl = "https://api.tavily.com";

    /** 连接超时（毫秒） */
    private int connectTimeout = 10000;

    /** 读取超时（毫秒） */
    private int readTimeout = 30000;

    /** 默认最大搜索结果数 */
    private int maxResults = 5;
}
