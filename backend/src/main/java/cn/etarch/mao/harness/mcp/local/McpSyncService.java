package cn.etarch.mao.harness.mcp.local;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.harness.mcp.McpClientManager;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.mapper.McpServerMapper;
import cn.etarch.mao.harness.mcp.model.McpToolRef;
import cn.etarch.mao.harness.mcp.preference.service.UserMcpPreferenceService;
import cn.etarch.mao.harness.mcp.service.McpServerService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * MCP 双模式加载编排：
 * <ul>
 *   <li>解析 Agent 关联的服务器并加载（过滤已停用/已删除，保持配置顺序；</li>
 *   <li>可选按用户过滤——用户在客户端设置页停用的服务器不注入该用户会话）；</li>
 *   <li>CLOUD：逐台建立会话级连接并拉取工具清单，单台失败降级（不注入该服务器工具并提示原因）；</li>
 *   <li>LOCAL：提供 WS 下发所需配置载荷，接收桌面端上报写入 {@link McpToolsRegistry}。</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class McpSyncService {

    private final McpServerMapper mcpServerMapper;
    private final McpServerService mcpServerService;
    private final McpToolsRegistry toolsRegistry;
    private final ObjectMapper objectMapper;
    private final UserMcpPreferenceService userMcpPreferenceService;

    /** CLOUD 模式连接结果：成功注入的工具 + 失败服务器提示。 */
    public record CloudConnectResult(List<McpToolRef> tools, List<String> warnings) {
    }

    /**
     * 解析 Agent 配置的 MCP 服务器 ID 列表（JSON 数组）。
     */
    public List<Long> parseAgentServerIds(Agent agent) {
        if (agent == null || agent.getMcpServerIds() == null || agent.getMcpServerIds().isBlank()) {
            return List.of();
        }
        try {
            List<Long> ids = objectMapper.readValue(agent.getMcpServerIds(),
                    new TypeReference<List<Long>>() {});
            return ids != null ? ids : List.of();
        } catch (Exception e) {
            log.warn("Failed to parse mcpServerIds for agent {}: {}", agent.getId(), e.getMessage());
            return List.of();
        }
    }

    /**
     * 按配置顺序加载 Agent 关联的已启用 MCP 服务器（跳过不存在 / 已停用的）。
     * 不带用户过滤（等价于 userId=null）。
     */
    public List<McpServer> loadAgentServers(Agent agent) {
        return loadAgentServers(agent, null);
    }

    /**
     * 按配置顺序加载 Agent 关联的已启用 MCP 服务器（跳过不存在 / 已停用的），
     * 并按用户级偏好过滤：用户在客户端设置页停用的服务器不加载（仅影响本人会话）。
     */
    public List<McpServer> loadAgentServers(Agent agent, Long userId) {
        List<Long> ids = parseAgentServerIds(agent);
        if (ids.isEmpty()) {
            return List.of();
        }
        List<Long> disabledByUser = userId != null
                ? userMcpPreferenceService.getDisabledServerIds(userId) : List.of();
        List<McpServer> result = new ArrayList<>();
        for (Long id : ids) {
            if (id == null) {
                continue;
            }
            if (disabledByUser.contains(id)) {
                log.debug("Skipping MCP server id={} disabled by user {}", id, userId);
                continue;
            }
            McpServer server = mcpServerMapper.selectById(id);
            if (server == null || McpServer.STATUS_DISABLED.equals(server.getStatus())) {
                log.debug("Skipping unavailable MCP server id={} for agent {}", id, agent != null ? agent.getId() : null);
                continue;
            }
            result.add(server);
        }
        return result;
    }

    /**
     * CLOUD 模式：逐台建立会话级连接并拉取工具清单。
     * 单台失败不阻断整体，失败原因收集到 warnings 供 PromptEngine 注入提示。
     */
    public CloudConnectResult connectForCloud(Long sessionId, List<McpServer> servers,
                                              McpClientManager clientManager) {
        List<McpToolRef> tools = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        for (McpServer server : servers) {
            try {
                Map<String, String> env = mcpServerService.decryptEnv(server);
                List<McpToolRef> serverTools = clientManager.connectAndListTools(sessionId, server, env);
                tools.addAll(serverTools);
            } catch (Exception e) {
                log.warn("MCP server {} connect failed for session {}: {}", server.getName(), sessionId, e.getMessage());
                warnings.add("MCP 服务器 `" + server.getName() + "` 不可用：" + e.getMessage());
            }
        }
        return new CloudConnectResult(tools, warnings);
    }

    /**
     * LOCAL 模式：构造 WS 下发载荷（含解密后的环境变量，供桌面端启动子进程/请求头使用）。
     * 返回 null 表示无可下发服务器。
     */
    public Map<String, Object> buildSyncPayload(List<McpServer> servers) {
        if (servers.isEmpty()) {
            return null;
        }
        List<Map<String, Object>> payloadServers = new ArrayList<>();
        for (McpServer server : servers) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", server.getName());
            item.put("type", server.getServerType());
            if (McpServer.TYPE_STDIO.equals(server.getServerType())) {
                item.put("command", server.getCommand());
                item.put("args", parseArgs(server.getArgsJson()));
            } else {
                item.put("url", server.getUrl());
            }
            item.put("env", mcpServerService.decryptEnv(server));
            payloadServers.add(item);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("servers", payloadServers);
        return payload;
    }

    /**
     * 接收桌面端 mcp_tools_report，写入工具清单缓存。
     * 仅合并 connected=true 的服务器工具。
     */
    public void recordReport(Long sessionId, List<McpToolRef> tools) {
        toolsRegistry.report(sessionId, tools);
    }

    /** 按名称反查服务器 ID（LOCAL 上报只有名称）；不存在返回 null。 */
    public Long resolveServerIdByName(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        McpServer server = mcpServerMapper.selectOne(
                new LambdaQueryWrapper<McpServer>().eq(McpServer::getName, name).last("LIMIT 1"));
        return server != null ? server.getId() : null;
    }

    /** LOCAL 模式读取会话工具清单（buildContext 使用）。 */
    public List<McpToolRef> getLocalSessionTools(Long sessionId) {
        return toolsRegistry.getSessionTools(sessionId);
    }

    public void clearSession(Long sessionId) {
        toolsRegistry.clear(sessionId);
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
            log.warn("Failed to parse MCP server args: {}", e.getMessage());
            return List.of();
        }
    }
}
