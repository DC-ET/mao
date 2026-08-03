package cn.etarch.mao.harness.mcp;

import cn.etarch.mao.harness.mcp.model.McpToolRef;
import cn.etarch.mao.harness.tool.Tool;
import lombok.extern.slf4j.Slf4j;

import java.util.Map;

/**
 * 将 MCP 工具包装为标准 {@link Tool} 接口，使 harness 全链路（schema 注入、执行调度、
 * 结果摘要）透明复用。
 * <p>
 * 命名：{@code mcp__{serverName}__{toolName}}，与内置工具命名空间隔离。
 * <p>
 * 执行语义：
 * <ul>
 *   <li>CLOUD 模式：{@link McpClientManager#callTool} 直连执行（ToolDispatcher 直接调用本 adapter）；</li>
 *   <li>LOCAL 模式：本 adapter 仅承载 schema；执行由 ToolDispatcher 的 LOCAL 分支按完整工具名
 *       委托桌面端（Electron）经 WebSocket 执行，桌面端按 {@code serverName + toolName} 路由。</li>
 * </ul>
 */
@Slf4j
public class McpToolAdapter implements Tool {

    private final McpToolRef ref;
    private final McpClientManager clientManager;

    public McpToolAdapter(McpToolRef ref, McpClientManager clientManager) {
        this.ref = ref;
        this.clientManager = clientManager;
    }

    @Override
    public String getName() {
        return ref.getFullToolName();
    }

    @Override
    public String getDescription() {
        return ref.getDescription();
    }

    @Override
    public Map<String, Object> getInputSchema() {
        return ref.getInputSchema();
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object", "description", "MCP 工具执行结果");
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        return execute(arguments, null, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        return execute(arguments, sessionId, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        if (clientManager == null) {
            return "{\"error\":\"MCP 工具在 LOCAL 模式下由桌面端执行，服务端无法直接调用\"}";
        }
        return clientManager.callTool(sessionId, ref.getServerId(), ref.getToolName(), arguments);
    }

    public McpToolRef getRef() {
        return ref;
    }
}
