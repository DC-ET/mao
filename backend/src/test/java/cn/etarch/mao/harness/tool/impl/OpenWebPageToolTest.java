package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.config.WebPageConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
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
        config.setMaxRawBytes(1048576);
        config.setUserAgent("Mozilla/5.0 (compatible; AgentWorkbench/1.0; Test)");
        tool = new OpenWebPageTool(objectMapper, config);
    }

    /** 启动本地 HTTP 服务器返回指定 HTML，避免单元测试依赖外部网络。 */
    private HttpServer startServer(String html) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] body = html.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        return server;
    }

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    void shouldFetchAndExtractFromPublicPage() throws Exception {
        // 用本地 HTTP 服务器替代外部 httpbin.org，保证测试稳定可重复
        String html = """
                <html><head><title>Test Article</title></head><body>
                <nav>导航栏</nav>
                <article>
                <h1>Hello World</h1>
                <p>这是第一段用于正文提取验证的内容。</p>
                <p>这是第二段正文，包含足够多的文字用于验证 Boilerpipe 与容器提取的降级路径。</p>
                </article>
                </body></html>
                """;
        HttpServer server = startServer(html);
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/html";
            String args = objectMapper.writeValueAsString(Map.of("url", url));
            String result = tool.execute(args);

            System.out.println("Result: " + result.substring(0, Math.min(500, result.length())));

            var node = objectMapper.readTree(result);
            assertThat(node.has("error")).as("should not have error: " + result).isFalse();
            assertThat(node.get("url").asText()).isEqualTo(url);
            assertThat(node.get("content").asText()).isNotEmpty();
        } finally {
            server.stop(0);
        }
    }

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    void shouldFetchAndExtractFromMinimalPage() throws Exception {
        // 极简页面——验证 Boilerpipe 不抛异常即可
        String html = "<html><head><title>Minimal</title></head><body><p>hello</p></body></html>";
        HttpServer server = startServer(html);
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/minimal";
            String args = objectMapper.writeValueAsString(Map.of("url", url));
            String result = tool.execute(args);

            System.out.println("Minimal result: " + result);

            var node = objectMapper.readTree(result);
            // 页面太简单可能 content 为空，但不应该有 error
            assertThat(node.has("error")).as("should not have error: " + result).isFalse();
            assertThat(node.get("url").asText()).isEqualTo(url);
        } finally {
            server.stop(0);
        }
    }

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS)
    void shouldFetchAndExtractRealisticPage() throws Exception {
        // 较完整的真实风格页面：验证 title、content、content_length 等字段
        String html = """
                <html><head>
                <meta property="og:title" content="产品发布公告" />
                <title>产品发布公告</title>
                </head><body>
                <header>站点头部</header>
                <main>
                <h1>产品发布公告</h1>
                <p>今天我们发布了 2.0 版本，带来了全新界面与更快的性能。</p>
                <p>新版本修复了若干已知问题，并增加了对多语言的支持。</p>
                </main>
                <footer>站点页脚</footer>
                </body></html>
                """;
        HttpServer server = startServer(html);
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/article";
            String args = objectMapper.writeValueAsString(Map.of("url", url));
            String result = tool.execute(args);

            System.out.println("Realistic result (first 500): " + result.substring(0, Math.min(500, result.length())));

            var node = objectMapper.readTree(result);
            assertThat(node.has("error")).as("should not have error: " + result).isFalse();
            assertThat(node.get("url").asText()).isEqualTo(url);
            assertThat(node.get("title").asText()).contains("产品发布公告");
            assertThat(node.get("content").asText()).contains("2.0 版本");
        } finally {
            server.stop(0);
        }
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
