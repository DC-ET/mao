package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

@Slf4j
@Component
public class HttpRequestTool implements Tool {

    private final OkHttpClient httpClient;
    private final ObjectMapper objectMapper;

    public HttpRequestTool(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.SECONDS)
                .build();
    }

    @Override
    public String getName() {
        return "http_request";
    }

    @Override
    public String getDescription() {
        return "Send HTTP requests. Supports GET, POST, PUT, DELETE. Parameters: method, url, headers (optional), body (optional).";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("method", Map.of("type", "string", "enum", new String[]{"GET", "POST", "PUT", "DELETE"}));
        properties.put("url", Map.of("type", "string"));
        properties.put("headers", Map.of("type", "object"));
        properties.put("body", Map.of("type", "string"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"method", "url"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("status", Map.of("type", "integer"));
        properties.put("body", Map.of("type", "string"));
        schema.put("properties", properties);
        return schema;
    }

    private static final Set<String> BLOCKED_HOSTS = Set.of(
            "localhost", "127.0.0.1", "0.0.0.0", "::1"
    );

    @Override
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String method = args.get("method").asText();
            String url = args.get("url").asText();

            validateUrl(url);

            Request.Builder builder = new Request.Builder().url(url);

            if (args.has("headers")) {
                JsonNode headers = args.get("headers");
                headers.fields().forEachRemaining(entry ->
                        builder.addHeader(entry.getKey(), entry.getValue().asText()));
            }

            if (!"GET".equals(method) && args.has("body")) {
                String body = args.get("body").isTextual()
                        ? args.get("body").asText()
                        : args.get("body").toString();
                builder.method(method, RequestBody.create(body, MediaType.parse("application/json")));
            } else {
                builder.method(method, RequestBody.create("", null));
            }

            try (Response response = httpClient.newCall(builder.build()).execute()) {
                String responseBody = response.body() != null ? response.body().string() : "";
                return objectMapper.writeValueAsString(Map.of(
                        "status", response.code(),
                        "body", responseBody.length() > 2000 ? responseBody.substring(0, 2000) : responseBody
                ));
            }
        } catch (Exception e) {
            log.error("HttpRequestTool execution failed", e);
            return "{\"status\":0,\"body\":\"Error: " + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    private void validateUrl(String url) {
        try {
            URI uri = URI.create(url);
            String host = uri.getHost();
            if (host == null) {
                throw new SecurityException("Invalid URL: no host");
            }

            if (BLOCKED_HOSTS.contains(host.toLowerCase())) {
                throw new SecurityException("Access to internal host blocked: " + host);
            }

            InetAddress address = InetAddress.getByName(host);
            if (address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress()) {
                throw new SecurityException("Access to internal/private network blocked: " + host);
            }
        } catch (SecurityException e) {
            throw e;
        } catch (Exception e) {
            throw new SecurityException("URL validation failed: " + e.getMessage());
        }
    }
}
