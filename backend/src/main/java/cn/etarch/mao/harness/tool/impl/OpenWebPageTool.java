package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.config.WebPageConfig;
import cn.etarch.mao.harness.tool.Tool;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vladsch.flexmark.html2md.converter.FlexmarkHtmlConverter;
import de.l3s.boilerpipe.extractors.ArticleExtractor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 打开网页并提取正文内容，以 Markdown 格式返回。
 */
@Slf4j
@Component
public class OpenWebPageTool implements Tool {

    private final ObjectMapper objectMapper;
    private final OkHttpClient httpClient;
    private final WebPageConfig webPageConfig;

    public OpenWebPageTool(ObjectMapper objectMapper, WebPageConfig webPageConfig) {
        this.objectMapper = objectMapper;
        this.webPageConfig = webPageConfig;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(webPageConfig.getConnectTimeout(), TimeUnit.MILLISECONDS)
                .readTimeout(webPageConfig.getReadTimeout(), TimeUnit.MILLISECONDS)
                .build();
    }

    @Override
    public String getName() {
        return "open_web_page";
    }

    @Override
    public String getDescription() {
        return "打开指定 URL 对应的网页，提取正文内容并以 Markdown 格式返回。帮助 Agent 获取外部网页的详细内容。";
    }

    @Override
    public String getToolPrompt() {
        return """
                ## open_web_page 工具使用指南

                - open_web_page 用于打开指定 URL 并获取网页的 Markdown 格式正文内容。
                - 当需要阅读某篇具体文章、文档页面、API 参考等网页的详细内容时使用。
                - 网页内容会经过正文提取（去除导航栏、广告等干扰内容）后转为 Markdown。
                - 如果页面需要 JavaScript 渲染（SPA 应用），提取的内容可能不完整。
                - 建议配合 web_search 使用：先用 web_search 发现相关页面，再用 open_web_page 获取详情。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("url", Map.of("type", "string", "description", "目标网页 URL（需包含协议，如 https://...）"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"url"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("url", Map.of("type", "string"));
        properties.put("title", Map.of("type", "string"));
        properties.put("content", Map.of("type", "string"));
        properties.put("content_length", Map.of("type", "integer"));
        properties.put("truncated", Map.of("type", "boolean"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        return execute(arguments, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        String url;
        try {
            var args = objectMapper.readTree(arguments);
            url = args.get("url").asText();
            if (url == null || url.isBlank()) {
                return errorJson("URL 不能为空", "");
            }
        } catch (Exception e) {
            return errorJson("参数解析失败：" + e.getMessage(), "");
        }

        // Validate URL protocol
        String lowerUrl = url.toLowerCase();
        if (!lowerUrl.startsWith("http://") && !lowerUrl.startsWith("https://")) {
            return errorJson("不支持的协议，仅支持 http:// 和 https://", url);
        }

        return fetchAndExtract(url);
    }

    private String fetchAndExtract(String url) {
        try {
            Request request = new Request.Builder()
                    .url(url)
                    .header("User-Agent", webPageConfig.getUserAgent())
                    .header("Accept", "text/html,application/xhtml+xml")
                    .get()
                    .build();

            try (Response response = httpClient.newCall(request).execute()) {
                if (!response.isSuccessful()) {
                    return errorJson("HTTP " + response.code() + "：请求失败", url);
                }

                ResponseBody body = response.body();
                if (body == null) {
                    return errorJson("响应体为空", url);
                }

                // Read response body with size limit
                String contentType = body.contentType() != null
                        ? body.contentType().toString()
                        : "";

                // Only process HTML content
                if (!contentType.contains("text/html") && !contentType.isBlank()) {
                    return errorJson("不支持的内容类型：" + contentType + "，仅支持 text/html", url);
                }

                // Read raw HTML with size limit — Boilerpipe needs complete HTML
                byte[] rawBytes = body.bytes();
                int maxRaw = webPageConfig.getMaxRawBytes();
                if (rawBytes.length > maxRaw) {
                    rawBytes = java.util.Arrays.copyOf(rawBytes, maxRaw);
                }

                // Determine encoding: try Content-Type charset first, then HTML meta tags
                String html;
                String charsetName = extractCharset(contentType);
                if (charsetName != null) {
                    html = new String(rawBytes, java.nio.charset.Charset.forName(charsetName));
                } else {
                    // Detect from HTML meta tag or fallback to UTF-8
                    String probe = new String(rawBytes, java.nio.charset.StandardCharsets.UTF_8);
                    String detectedCharset = extractCharsetFromMeta(probe);
                    if (detectedCharset != null) {
                        html = new String(rawBytes, java.nio.charset.Charset.forName(detectedCharset));
                    } else {
                        html = probe;
                    }
                }

                // Extract page title from HTML
                String title = extractTitle(html);

                // Extract main content using Boilerpipe
                String extractedHtml = ArticleExtractor.INSTANCE.getText(html);

                // Convert HTML to Markdown using flexmark
                String markdown = FlexmarkHtmlConverter.builder().build().convert(extractedHtml);

                // truncated 指提取后的 Markdown 是否因输出长度限制被截断
                boolean truncated = false;
                int maxOutput = webPageConfig.getMaxOutputLength();
                if (markdown.length() > maxOutput) {
                    markdown = markdown.substring(0, maxOutput)
                            + "\n\n... [内容过长，已截断]";
                    truncated = true;
                }

                return objectMapper.writeValueAsString(Map.of(
                        "url", url,
                        "title", title != null ? title : "",
                        "content", markdown,
                        "content_length", markdown.length(),
                        "truncated", truncated
                ));
            }

        } catch (java.net.SocketTimeoutException e) {
            log.error("OpenWebPage timed out for URL: {}", url, e);
            return errorJson("请求超时，目标网站无响应", url);
        } catch (java.net.UnknownHostException e) {
            log.error("OpenWebPage DNS resolution failed for URL: {}", url, e);
            return errorJson("无法解析域名：" + e.getMessage(), url);
        } catch (Exception e) {
            log.error("OpenWebPageTool execution failed for URL: {}", url, e);
            return errorJson("网页内容获取失败：" + e.getMessage(), url);
        }
    }

    /**
     * 从 Content-Type header 提取 charset。
     */
    private String extractCharset(String contentType) {
        if (contentType == null || contentType.isBlank()) return null;
        for (String part : contentType.split(";")) {
            String trimmed = part.trim();
            if (trimmed.toLowerCase().startsWith("charset=")) {
                return trimmed.substring("charset=".length()).trim();
            }
        }
        return null;
    }

    /**
     * 从 HTML meta 标签中提取 charset。
     */
    private String extractCharsetFromMeta(String html) {
        if (html == null || html.isBlank()) return null;
        // Match: <meta charset="UTF-8">
        var pattern1 = java.util.regex.Pattern.compile("<meta[^>]+charset=[\"']?([a-zA-Z0-9\\-_]+)[\"']?", java.util.regex.Pattern.CASE_INSENSITIVE);
        var matcher1 = pattern1.matcher(html);
        if (matcher1.find()) {
            return matcher1.group(1);
        }
        // Match: <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"
        var pattern2 = java.util.regex.Pattern.compile("<meta[^>]+charset=([a-zA-Z0-9\\-_]+)", java.util.regex.Pattern.CASE_INSENSITIVE);
        var matcher2 = pattern2.matcher(html);
        if (matcher2.find()) {
            return matcher2.group(1);
        }
        return null;
    }

    /**
     * 从 HTML 中提取 title。
     */
    private String extractTitle(String html) {
        if (html == null || html.isBlank()) return null;
        var pattern = java.util.regex.Pattern.compile("<title[^>]*>(.*?)</title>", java.util.regex.Pattern.CASE_INSENSITIVE | java.util.regex.Pattern.DOTALL);
        var matcher = pattern.matcher(html);
        if (matcher.find()) {
            return matcher.group(1).trim();
        }
        return null;
    }

    private String errorJson(String message, String url) {
        try {
            return objectMapper.writeValueAsString(Map.of(
                    "error", message,
                    "url", url
            ));
        } catch (Exception e) {
            return "{\"error\":\"" + message.replace("\"", "'") + "\",\"url\":\"" + url + "\"}";
        }
    }
}
