package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.config.WebPageConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class OpenWebPageToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private WebPageConfig config;
    private OpenWebPageTool tool;

    @BeforeEach
    void setUp() {
        config = new WebPageConfig();
        config.setConnectTimeout(5000);
        config.setReadTimeout(10000);
        config.setMaxRawBytes(500000);
        config.setUserAgent("Mozilla/5.0 (compatible; AgentWorkbench/1.0; Test)");
        tool = new OpenWebPageTool(objectMapper, config);
    }

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    void shouldFetchAndExtractFromPublicPage() throws Exception {
        // example.com 页面太简单，Boilerpipe 可能提取为空，用 httpbin 的 HTML 页面验证
        String args = objectMapper.writeValueAsString(Map.of("url", "http://httpbin.org/html"));
        String result = tool.execute(args);

        System.out.println("Result: " + result.substring(0, Math.min(500, result.length())));

        var node = objectMapper.readTree(result);
        assertThat(node.has("error")).as("should not have error: " + result).isFalse();
        assertThat(node.get("url").asText()).isEqualTo("http://httpbin.org/html");
        assertThat(node.get("content").asText()).isNotEmpty();
    }

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    void shouldFetchAndExtractFromMinimalPage() throws Exception {
        // example.com 极简页面——验证 Boilerpipe 不抛异常即可
        String args = objectMapper.writeValueAsString(Map.of("url", "http://example.com"));
        String result = tool.execute(args);

        System.out.println("Example result: " + result);

        var node = objectMapper.readTree(result);
        // 页面太简单可能 content 为空，但不应该有 error
        assertThat(node.has("error")).as("should not have error: " + result).isFalse();
        assertThat(node.get("url").asText()).isEqualTo("http://example.com");
    }

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    void shouldFetchAndExtractRealWorldPage() throws Exception {
        // 测试真实网页：百度百科
        String args = objectMapper.writeValueAsString(Map.of("url", "https://www.baidu.com"));
        String result = tool.execute(args);

        System.out.println("Baidu result (first 500): " + result.substring(0, Math.min(500, result.length())));

        var node = objectMapper.readTree(result);
        // 百度可能因反爬返回异常，这里只验证不抛异常
        assertThat(node.has("url")).isTrue();
    }

    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS)
    void shouldReturnErrorOnTimeout() throws Exception {
        // 用很短的超时 + 慢速或不存在的地址
        config.setConnectTimeout(100);   // 100ms
        config.setReadTimeout(100);       // 100ms

        String args = objectMapper.writeValueAsString(Map.of("url", "https://10.255.255.1"));
        String result = tool.execute(args);

        System.out.println("Timeout result: " + result);

        var node = objectMapper.readTree(result);
        assertThat(node.has("error")).as("should have error on timeout").isTrue();
    }

    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS)
    void shouldRejectNonHttpProtocol() throws Exception {
        String args = objectMapper.writeValueAsString(Map.of("url", "file:///etc/passwd"));
        String result = tool.execute(args);

        System.out.println("Protocol reject result: " + result);

        var node = objectMapper.readTree(result);
        assertThat(node.has("error")).isTrue();
        assertThat(node.get("error").asText()).contains("不支持的协议");
    }

    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS)
    void shouldReturnErrorOnEmptyUrl() throws Exception {
        String args = objectMapper.writeValueAsString(Map.of("url", ""));
        String result = tool.execute(args);

        var node = objectMapper.readTree(result);
        assertThat(node.has("error")).isTrue();
        assertThat(node.get("error").asText()).contains("不能为空");
    }
}
