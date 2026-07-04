package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.config.WebPageConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.Map;
import java.util.concurrent.TimeUnit;

class OpenWebPageToolWechatTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private OpenWebPageTool tool;

    @BeforeEach
    void setUp() {
        WebPageConfig config = new WebPageConfig();
        config.setConnectTimeout(15000);
        config.setReadTimeout(30000);
        config.setMaxRawBytes(500000);
        config.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        tool = new OpenWebPageTool(objectMapper, config);
    }

    @Test
    @Timeout(value = 60, unit = TimeUnit.SECONDS)
    void shouldFetchWechatArticle() throws Exception {
        String url = "https://mp.weixin.qq.com/s/B7bxbefSEiWrT23_8YK8mQ";
        String args = objectMapper.writeValueAsString(Map.of("url", url));

        long start = System.currentTimeMillis();
        String result = tool.execute(args);
        long elapsed = System.currentTimeMillis() - start;

        System.out.println("=== 耗时: " + elapsed + "ms ===");
        System.out.println("=== 结果 ===");
        System.out.println(result);
    }
}
