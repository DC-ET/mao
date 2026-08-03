package cn.etarch.mao.harness.mcp.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

/**
 * MCP 工具引用信息。
 * <p>
 * 作为工具清单的载体：CLOUD 模式由 {@code McpClientManager} 从服务器拉取，
 * LOCAL 模式由桌面端经 WS 上报，统一转换成该模型后注入 {@code ToolRegistry} 外层适配器。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class McpToolRef {

    /** 所属 MCP 服务器 ID（DB 主键），CLOUD 模式定位连接使用 */
    private Long serverId;

    /** 所属 MCP 服务器名称（mcp_server.name），工具名前缀来源 */
    private String serverName;

    /** MCP 工具原名（服务器声明的 name） */
    private String toolName;

    /** 工具描述（服务器声明） */
    private String description;

    /** 工具输入参数 JSON Schema（服务器声明） */
    private Map<String, Object> inputSchema;

    /** 完整工具名：mcp__{serverName}__{toolName} */
    public String getFullToolName() {
        return "mcp__" + serverName + "__" + toolName;
    }
}
