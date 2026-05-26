package com.agentworkbench.harness.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@Slf4j
@Component
public class McpClient {

    private final OkHttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final AtomicInteger rpcId = new AtomicInteger(0);

    public McpClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.SECONDS)
                .build();
    }

    /**
     * Discover tools from an MCP server via SSE transport
     * Sends initialize + tools/list via HTTP POST (JSON-RPC), reads SSE response
     */
    @SuppressWarnings("unused")
    public List<McpTool> discoverTools(String serverUrl) {
        try {
            // 1. Initialize
            Map<String, Object> initResult = sendRequest(serverUrl, "initialize", Map.of(
                    "protocolVersion", "2024-11-05",
                    "capabilities", Map.of(),
                    "clientInfo", Map.of("name", "agent-workbench", "version", "1.0.0")
            ));

            // 2. Send initialized notification
            sendNotification(serverUrl, "notifications/initialized", Map.of());

            // 3. List tools
            Map<String, Object> toolsResult = sendRequest(serverUrl, "tools/list", Map.of());

            List<McpTool> tools = new ArrayList<>();
            JsonNode toolsNode = objectMapper.valueToTree(toolsResult);
            JsonNode toolsArray = toolsNode.path("tools");
            if (toolsArray.isArray()) {
                for (JsonNode toolNode : toolsArray) {
                    McpTool tool = McpTool.builder()
                            .name(toolNode.path("name").asText())
                            .description(toolNode.path("description").asText(""))
                            .inputSchema(toJsonMap(toolNode.path("inputSchema")))
                            .serverUrl(serverUrl)
                            .build();
                    tools.add(tool);
                }
            }

            log.info("Discovered {} tools from MCP server: {}", tools.size(), serverUrl);
            return tools;

        } catch (Exception e) {
            log.error("Failed to discover tools from MCP server: {}", serverUrl, e);
            return List.of();
        }
    }

    /**
     * Call a tool on an MCP server
     */
    public String callTool(String serverUrl, String toolName, Map<String, Object> arguments) {
        try {
            Map<String, Object> result = sendRequest(serverUrl, "tools/call", Map.of(
                    "name", toolName,
                    "arguments", arguments
            ));
            JsonNode resultNode = objectMapper.valueToTree(result);
            JsonNode content = resultNode.path("content");
            if (content.isArray() && content.size() > 0) {
                JsonNode first = content.get(0);
                if ("text".equals(first.path("type").asText())) {
                    return first.path("text").asText();
                }
            }
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("Failed to call MCP tool {} on server {}", toolName, serverUrl, e);
            return "Error: " + e.getMessage();
        }
    }

    private Map<String, Object> sendRequest(String serverUrl, String method, Map<String, Object> params) throws IOException {
        int id = rpcId.incrementAndGet();
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("jsonrpc", "2.0");
        request.put("id", id);
        request.put("method", method);
        request.put("params", params);

        String json = objectMapper.writeValueAsString(request);
        Request httpRequest = new Request.Builder()
                .url(serverUrl)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .post(RequestBody.create(json, MediaType.parse("application/json")))
                .build();

        try (Response response = httpClient.newCall(httpRequest).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("MCP server returned " + response.code());
            }
            ResponseBody body = response.body();
            if (body == null) {
                throw new IOException("MCP server returned empty body");
            }

            String contentType = response.header("Content-Type", "");
            if (contentType.contains("text/event-stream")) {
                return parseSseResponse(body.string(), id);
            } else {
                return parseJsonResponse(body.string());
            }
        }
    }

    private void sendNotification(String serverUrl, String method, Map<String, Object> params) throws IOException {
        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("jsonrpc", "2.0");
        notification.put("method", method);
        notification.put("params", params);

        String json = objectMapper.writeValueAsString(notification);
        Request httpRequest = new Request.Builder()
                .url(serverUrl)
                .header("Content-Type", "application/json")
                .post(RequestBody.create(json, MediaType.parse("application/json")))
                .build();

        try (Response response = httpClient.newCall(httpRequest).execute()) {
            // Notifications don't require a response
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseSseResponse(String sseBody, int expectedId) throws IOException {
        for (String line : sseBody.split("\n")) {
            if (line.startsWith("data: ")) {
                String data = line.substring(6).trim();
                if (!data.isEmpty()) {
                    JsonNode node = objectMapper.readTree(data);
                    if (node.has("id") && node.get("id").asInt() == expectedId) {
                        if (node.has("result")) {
                            return objectMapper.convertValue(node.get("result"), Map.class);
                        }
                        if (node.has("error")) {
                            throw new IOException("MCP error: " + node.get("error"));
                        }
                    }
                }
            }
        }
        throw new IOException("No matching response found in SSE stream");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseJsonResponse(String json) throws IOException {
        JsonNode node = objectMapper.readTree(json);
        if (node.has("result")) {
            return objectMapper.convertValue(node.get("result"), Map.class);
        }
        if (node.has("error")) {
            throw new IOException("MCP error: " + node.get("error"));
        }
        throw new IOException("Unexpected MCP response: " + json);
    }

    private Map<String, Object> toJsonMap(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return Map.of();
        }
        return objectMapper.convertValue(node, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
    }
}
