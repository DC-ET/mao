package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.config.TavilyConfig;
import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 全网搜索工具，底层对接 Tavily Search API。
 */
@Slf4j
@Component
public class WebSearchTool implements Tool {

    private static final MediaType JSON_MEDIA_TYPE = MediaType.parse("application/json");
    private static final int MIN_RESULTS = 1;
    private static final int MAX_RESULTS = 10;

    private final ObjectMapper objectMapper;
    private final OkHttpClient httpClient;
    private final TavilyConfig tavilyConfig;

    public WebSearchTool(ObjectMapper objectMapper, TavilyConfig tavilyConfig) {
        this.objectMapper = objectMapper;
        this.tavilyConfig = tavilyConfig;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(tavilyConfig.getConnectTimeout(), TimeUnit.MILLISECONDS)
                .readTimeout(tavilyConfig.getReadTimeout(), TimeUnit.MILLISECONDS)
                .build();
    }

    @Override
    public String getName() {
        return "web_search";
    }

    @Override
    public String getDescription() {
        return "使用 Tavily 搜索引擎进行全网搜索。返回匹配的网页结果列表，包含标题、URL 和内容摘要。帮助 Agent 获取最新信息和外部知识。";
    }

    @Override
    public String getToolPrompt() {
        return """
                ## web_search 工具使用指南

                - web_search 用于搜索互联网获取最新信息，底层对接 Tavily 搜索引擎。
                - 当需要实时信息、最新文档、近期事件时使用此工具。
                - 搜索结果包含标题、URL 和内容摘要。摘要可能不完整，如需获取完整内容请使用 open_web_page 打开具体 URL。
                - 搜索关键词应简洁精准，避免过长的自然语言问题。
                - 搜索结果可能有噪声，请评估信息可靠性后再引用。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("query", Map.of("type", "string", "description", "搜索关键词或问题"));
        properties.put("max_results", Map.of("type", "integer", "description", "返回的最大结果数（1-10，默认 5）"));
        properties.put("search_depth", Map.of("type", "string", "description", "搜索深度：basic 或 advanced（默认 basic）"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"query"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("query", Map.of("type", "string"));
        properties.put("results", Map.of(
                "type", "array",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "title", Map.of("type", "string"),
                                "url", Map.of("type", "string"),
                                "content", Map.of("type", "string")
                        )
                )
        ));
        properties.put("total_results", Map.of("type", "integer"));
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
        try {
            var args = objectMapper.readTree(arguments);
            String query = args.get("query").asText();
            if (query == null || query.isBlank()) {
                return errorJson("搜索关键词不能为空");
            }

            String apiKey = tavilyConfig.getApiKey();
            if (apiKey == null || apiKey.isBlank()) {
                return errorJson("Tavily API Key 未配置，请在环境变量 TAVILY_API_KEY 中设置");
            }

            int maxResults = args.has("max_results")
                    ? clamp(args.get("max_results").asInt(tavilyConfig.getMaxResults()), MIN_RESULTS, MAX_RESULTS)
                    : tavilyConfig.getMaxResults();
            String searchDepth = args.has("search_depth") ? args.get("search_depth").asText() : "basic";

            // Build request body
            Map<String, Object> requestBody = new HashMap<>();
            requestBody.put("api_key", apiKey);
            requestBody.put("query", query);
            requestBody.put("max_results", maxResults);
            requestBody.put("search_depth", searchDepth);

            String requestJson = objectMapper.writeValueAsString(requestBody);
            log.debug("WebSearch request: {}", requestJson);

            Request request = new Request.Builder()
                    .url(tavilyConfig.getBaseUrl() + "/search")
                    .header("Content-Type", "application/json")
                    .post(RequestBody.create(requestJson, JSON_MEDIA_TYPE))
                    .build();

            try (Response response = httpClient.newCall(request).execute()) {
                ResponseBody body = response.body();
                String responseJson = body != null ? body.string() : "";

                if (!response.isSuccessful()) {
                    log.warn("Tavily API returned {}: {}", response.code(), responseJson);
                    return errorJson("Tavily API 返回错误 (HTTP " + response.code() + ")");
                }

                // Parse Tavily response and transform to our output schema
                var tavilyResponse = objectMapper.readTree(responseJson);
                var tavilyResults = tavilyResponse.get("results");

                List<Map<String, Object>> results = new ArrayList<>();
                if (tavilyResults != null && tavilyResults.isArray()) {
                    for (var item : tavilyResults) {
                        Map<String, Object> result = new HashMap<>();
                        result.put("title", item.has("title") ? item.get("title").asText() : "");
                        result.put("url", item.has("url") ? item.get("url").asText() : "");
                        result.put("content", item.has("content") ? item.get("content").asText() : "");
                        results.add(result);
                    }
                }

                return objectMapper.writeValueAsString(Map.of(
                        "query", query,
                        "results", results,
                        "total_results", results.size()
                ));
            }

        } catch (java.net.SocketTimeoutException e) {
            log.error("WebSearch timed out", e);
            return errorJson("搜索请求超时，请稍后重试");
        } catch (Exception e) {
            log.error("WebSearchTool execution failed", e);
            return errorJson("搜索失败：" + e.getMessage());
        }
    }

    private String errorJson(String message) {
        try {
            return objectMapper.writeValueAsString(Map.of("error", message));
        } catch (Exception e) {
            return "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
