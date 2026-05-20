package com.agentworkbench.harness.skill.impl;

import com.agentworkbench.harness.skill.Skill;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Slf4j
@Component
public class HttpRequestSkill implements Skill {

    private final OkHttpClient httpClient;
    private final ObjectMapper objectMapper;

    public HttpRequestSkill(ObjectMapper objectMapper) {
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

    @Override
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String method = args.get("method").asText();
            String url = args.get("url").asText();

            Request.Builder builder = new Request.Builder().url(url);

            // Add headers
            if (args.has("headers")) {
                JsonNode headers = args.get("headers");
                headers.fields().forEachRemaining(entry ->
                        builder.addHeader(entry.getKey(), entry.getValue().asText()));
            }

            // Add body for non-GET requests
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
            log.error("HttpRequestSkill execution failed", e);
            return "{\"status\":0,\"body\":\"Error: " + e.getMessage().replace("\"", "'") + "\"}";
        }
    }
}
