package cn.etarch.mao.harness.mcp;

import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.model.McpToolRef;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientStreamableHttpTransport;
import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.jackson3.JacksonMcpJsonMapper;
import io.modelcontextprotocol.spec.McpSchema;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * CLOUD 模式 MCP 客户端会话级连接管理。
 * <p>
 * 以 {@code sessionId → serverId → McpSyncClient} 维护会话级连接：
 * - 会话构建时 {@code connectAndListTools} 建立连接并拉取工具清单；
 * - Agent 执行期间 {@code callTool} 复用连接执行工具调用；
 * - 会话结束时 {@code closeSession} 统一关闭（终止 stdio 子进程 / 释放 HTTP 连接）。
 * <p>
 * 同一台服务器在管理后台「测试连接」场景不绑定会话：连接 → 拉取清单 → 立即关闭。
 */
@Slf4j
@Component
public class McpClientManager {

    /** 会话级连接：sessionId → serverId → client */
    private final ConcurrentMap<Long, ConcurrentMap<Long, McpSyncClient>> sessionClients = new ConcurrentHashMap<>();

    private final ObjectMapper objectMapper;
    private final McpJsonMapper jsonMapper;
    private final long clientTimeoutSeconds;

    public McpClientManager(ObjectMapper objectMapper,
                            @Value("${app.mcp.client-timeout-seconds:120}") long clientTimeoutSeconds) {
        this.objectMapper = objectMapper;
        this.jsonMapper = new JacksonMcpJsonMapper(JsonMapper.builder().build());
        this.clientTimeoutSeconds = clientTimeoutSeconds;
    }

    /**
     * 建立会话级连接并拉取工具清单（CLOUD 模式）。
     * 连接失败抛出异常，由调用方降级处理（不注入该服务器工具）。
     */
    public List<McpToolRef> connectAndListTools(Long sessionId, McpServer server, Map<String, String> env) {
        McpSyncClient client = connect(server, env);
        sessionClients.computeIfAbsent(sessionId, k -> new ConcurrentHashMap<>())
                .put(server.getId(), client);
        List<McpToolRef> tools = toToolRefs(server, client.listTools());
        log.info("MCP client connected (CLOUD): session={}, server={}, tools={}", sessionId, server.getName(), tools.size());
        return tools;
    }

    /**
     * 执行 MCP 工具调用（CLOUD 模式）。
     * 连接不存在时按需懒连接（同一会话内已建立的连接会被复用）。
     *
     * @return 工具执行结果（纯文本拼接）；失败返回含 error 字段的 JSON 字符串
     */
    public String callTool(Long sessionId, Long serverId, String toolName, String argumentsJson) {
        McpSyncClient client = getClient(sessionId, serverId);
        if (client == null) {
            return "{\"error\":\"MCP connection not found for serverId=" + serverId + "\"}";
        }
        try {
            Map<String, Object> args = parseArguments(argumentsJson);
            McpSchema.CallToolResult result = client.callTool(
                    McpSchema.CallToolRequest.builder().name(toolName).arguments(args).build());
            return formatResult(result);
        } catch (Exception e) {
            log.warn("MCP callTool failed: serverId={}, tool={}, error={}", serverId, toolName, e.getMessage());
            return "{\"error\":\"MCP tool call failed: " + escapeJson(e.getMessage()) + "\"}";
        }
    }

    /**
     * 测试连接：连接 → 拉取工具清单 → 关闭连接（管理后台「测试连接」/「查看工具」）。
     *
     * @return 服务器暴露的工具列表；连接失败抛出异常，由 Controller 转为错误提示
     */
    public List<McpToolRef> testConnection(McpServer server, Map<String, String> env) {
        McpSyncClient client = connect(server, env);
        try {
            List<McpToolRef> tools = toToolRefs(server, client.listTools());
            log.info("MCP test connection OK: server={}, tools={}", server.getName(), tools.size());
            return tools;
        } finally {
            closeClient(server.getName(), client);
        }
    }

    /**
     * 关闭会话的所有 MCP 连接（会话结束 / 断连清理）。
     */
    public void closeSession(Long sessionId) {
        ConcurrentMap<Long, McpSyncClient> clients = sessionClients.remove(sessionId);
        if (clients == null) {
            return;
        }
        clients.forEach((serverId, client) -> closeClient("session-" + sessionId + "/server-" + serverId, client));
        log.info("Closed {} MCP client connections for session {}", clients.size(), sessionId);
    }

    /** 会话是否有已建立的 MCP 连接。 */
    public boolean hasSessionClients(Long sessionId) {
        ConcurrentMap<Long, McpSyncClient> clients = sessionClients.get(sessionId);
        return clients != null && !clients.isEmpty();
    }

    // ── internal ──────────────────────────────────────────────────────

    private McpSyncClient getClient(Long sessionId, Long serverId) {
        ConcurrentMap<Long, McpSyncClient> clients = sessionClients.get(sessionId);
        return clients != null ? clients.get(serverId) : null;
    }

    private McpSyncClient connect(McpServer server, Map<String, String> env) {
        io.modelcontextprotocol.spec.McpClientTransport transport = buildTransport(server, env);
        try {
            McpSyncClient client = McpClient.sync(transport)
                    .requestTimeout(Duration.ofSeconds(clientTimeoutSeconds))
                    .initializationTimeout(Duration.ofSeconds(Math.min(clientTimeoutSeconds, 60)))
                    .build();
            client.initialize();
            return client;
        } catch (Exception e) {
            throw new IllegalStateException("连接 MCP 服务器 " + server.getName() + " 失败: " + e.getMessage(), e);
        }
    }

    private io.modelcontextprotocol.spec.McpClientTransport buildTransport(McpServer server, Map<String, String> env) {
        if (McpServer.TYPE_STDIO.equals(server.getServerType())) {
            List<String> args = parseArgs(server.getArgsJson());
            ServerParameters params = ServerParameters.builder(server.getCommand())
                    .args(args)
                    .env(env)
                    .build();
            return new StdioClientTransport(params, jsonMapper);
        }
        // HTTP/SSE：优先 Streamable HTTP（同时兼容 2025-03-26 与 2025-06-18 协议）
        HttpClientStreamableHttpTransport.Builder builder = HttpClientStreamableHttpTransport.builder(server.getUrl())
                .jsonMapper(jsonMapper)
                .connectTimeout(Duration.ofSeconds(Math.min(clientTimeoutSeconds, 30)));
        return builder.build();
    }

    private List<McpToolRef> toToolRefs(McpServer server, McpSchema.ListToolsResult result) {
        List<McpToolRef> refs = new ArrayList<>();
        if (result == null || result.tools() == null) {
            return refs;
        }
        for (McpSchema.Tool tool : result.tools()) {
            refs.add(new McpToolRef(server.getId(), server.getName(),
                    tool.name(), tool.description() != null ? tool.description() : "",
                    tool.inputSchema() != null ? tool.inputSchema() : Map.of()));
        }
        return refs;
    }

    private List<String> parseArgs(String argsJson) {
        if (argsJson == null || argsJson.isBlank()) {
            return List.of();
        }
        try {
            List<String> args = objectMapper.readValue(argsJson,
                    objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
            return args != null ? args : List.of();
        } catch (Exception e) {
            log.warn("Failed to parse MCP server args, using empty: {}", e.getMessage());
            return List.of();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseArguments(String argumentsJson) {
        if (argumentsJson == null || argumentsJson.isBlank()) {
            return Map.of();
        }
        try {
            Map<String, Object> args = objectMapper.readValue(argumentsJson, Map.class);
            return args != null ? args : Map.of();
        } catch (Exception e) {
            log.warn("Failed to parse MCP tool arguments, using empty: {}", e.getMessage());
            return Map.of();
        }
    }

    /**
     * 将 MCP 调用结果转为字符串：
     * - 服务器标记 isError → JSON 错误对象；
     * - 正常 → 拼接全部 TextContent；非文本内容（图片等）以占位描述标注；
     * - 存在 structuredContent 时优先序列化输出（结构化数据更利于 Agent 理解）。
     */
    private String formatResult(McpSchema.CallToolResult result) {
        if (result == null) {
            return "{\"error\":\"Empty MCP tool result\"}";
        }
        if (Boolean.TRUE.equals(result.isError())) {
            String text = extractText(result);
            return "{\"error\":\"" + escapeJson(text != null ? text : "MCP tool returned error") + "\"}";
        }
        if (result.structuredContent() != null) {
            try {
                return objectMapper.writeValueAsString(result.structuredContent());
            } catch (Exception ignored) {
                // fall through to text extraction
            }
        }
        StringBuilder sb = new StringBuilder();
        if (result.content() != null) {
            for (McpSchema.Content content : result.content()) {
                if (content instanceof McpSchema.TextContent textContent) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(textContent.text());
                } else if (content instanceof McpSchema.ImageContent) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append("[图片内容：MCP 服务器返回了图片（base64），请根据上下文说明图片内容]");
                } else {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append("[非文本内容：").append(content.getClass().getSimpleName()).append("]");
                }
            }
        }
        return sb.length() > 0 ? sb.toString() : "(MCP 工具返回空结果)";
    }

    private String extractText(McpSchema.CallToolResult result) {
        if (result.content() == null) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (McpSchema.Content content : result.content()) {
            if (content instanceof McpSchema.TextContent textContent) {
                if (sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(textContent.text());
            }
        }
        return sb.length() > 0 ? sb.toString() : null;
    }

    private void closeClient(String label, McpSyncClient client) {
        try {
            client.closeGracefully();
        } catch (Exception e) {
            log.debug("MCP client closeGracefully failed ({}), forcing close", label, e);
            try {
                client.close();
            } catch (Exception ignored) {
                // best effort
            }
        }
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
