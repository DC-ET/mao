package com.agentworkbench.harness.mcp;

import lombok.Builder;
import lombok.Data;

import java.util.Map;

/**
 * MCP 工具定义
 */
@Data
@Builder
public class McpTool {

    private String name;
    private String description;
    private Map<String, Object> inputSchema;

    // 来源 MCP Server 信息
    private String serverUrl;
    private String serverName;
}
