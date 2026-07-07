package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.harness.web-page")
public class WebPageConfig {

    /** 连接超时（毫秒） */
    private int connectTimeout = 10000;

    /** 读取超时（毫秒） */
    private int readTimeout = 30000;

    /** 原始 HTML 最大读取长度（字节），保证 Boilerpipe 能拿到完整 HTML */
    private int maxRawBytes = 1048576;

    /** 提取后 Markdown 输出最大长度（字符） */
    private int maxOutputLength = 500000;

    /** User-Agent */
    private String userAgent = "Mozilla/5.0 (compatible; AgentWorkbench/1.0)";
}
