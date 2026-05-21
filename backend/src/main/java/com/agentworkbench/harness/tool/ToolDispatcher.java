package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.local.LocalToolExecutor;
import com.agentworkbench.harness.mcp.McpToolRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class ToolDispatcher {

    private final ToolRegistry toolRegistry;
    private final McpToolRegistry mcpToolRegistry;
    private final LocalToolExecutor localToolExecutor;

    /**
     * Execute a tool call - routes to built-in Tool or MCP tool (cloud mode)
     */
    public String dispatch(String toolName, String arguments) {
        return dispatch(toolName, arguments, null);
    }

    /**
     * Execute a tool call with session workspace context (cloud mode).
     */
    public String dispatch(String toolName, String arguments, String workspace) {
        log.debug("Dispatching tool call (cloud): {}", toolName);

        // 1. Try built-in tools
        Tool tool = toolRegistry.getTool(toolName);
        if (tool != null) {
            log.debug("Routing to built-in tool: {}", toolName);
            return tool.execute(arguments, workspace);
        }

        // 2. Try MCP tools
        if (mcpToolRegistry.hasTool(toolName)) {
            log.debug("Routing to MCP tool: {}", toolName);
            return mcpToolRegistry.callTool(toolName, arguments);
        }

        throw new IllegalArgumentException("Unknown tool: " + toolName);
    }

    /**
     * Execute a tool call with execution mode routing.
     * LOCAL mode: delegates to LocalToolExecutor which sends via WebSocket to desktop client.
     * CLOUD mode: executes on server (default behavior).
     */
    public String dispatch(String toolName, String arguments, String executionMode, Long sessionId, String workspace) {
        if ("LOCAL".equals(executionMode)) {
            log.debug("Routing tool call to local executor: {} (session={})", toolName, sessionId);
            return localToolExecutor.execute(sessionId, toolName, arguments);
        }
        return dispatch(toolName, arguments, workspace);
    }
}
