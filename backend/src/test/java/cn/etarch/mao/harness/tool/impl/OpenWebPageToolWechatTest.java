package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.config.WebPageConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class OpenWebPageToolWechatTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private OpenWebPageTool tool;

    @BeforeEach
    void setUp() {
        WebPageConfig config = new WebPageConfig();
        config.setConnectTimeout(15000);
        config.setReadTimeout(30000);
        // 微信正文 js_content 通常在 500KB 之后，需保证能读到完整 HTML
        config.setMaxRawBytes(1048576);
        config.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        tool = new OpenWebPageTool(objectMapper, config);
    }

    @Test
    @Timeout(value = 60, unit = TimeUnit.SECONDS)
    void shouldFetchWechatArticleWithFullContent() throws Exception {
        String url = "https://mp.weixin.qq.com/s/GDCczcQuryGLdf2qeFvzbQ";
        String args = objectMapper.writeValueAsString(Map.of("url", url));

        String result = tool.execute(args);
        System.out.println("Result length: " + result.length());
        System.out.println("Result preview: " + result.substring(0, Math.min(800, result.length())));

        var node = objectMapper.readTree(result);
        assertThat(node.has("error")).as("should not error: " + result).isFalse();
        String content = node.get("content").asText();
        assertThat(content.length()).as("content should be much longer than Boilerpipe ~500 chars").isGreaterThan(2000);
        assertThat(content).contains("每六个月");
        assertThat(content).contains("先做自己想要的东西");
    }
}
