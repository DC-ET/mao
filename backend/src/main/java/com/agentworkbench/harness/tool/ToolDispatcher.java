package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.local.LocalToolExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class ToolDispatcher {

    private final ToolRegistry toolRegistry;
    private final LocalToolExecutor localToolExecutor;

    /**
     * Execute a tool call - routes to built-in tool (cloud mode)
     */
    public String dispatch(String toolName, String arguments) {
        return dispatch(toolName, arguments, null);
    }

    /**
     * Execute a tool call with session workspace context (cloud mode).
     */
    public String dispatch(String toolName, String arguments, String workspace) {
        log.debug("Dispatching tool call (cloud): {}", toolName);

        Tool tool = toolRegistry.getTool(toolName);
        if (tool != null) {
            log.debug("Routing to built-in tool: {}", toolName);
            return tool.execute(arguments, workspace);
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
            return localToolExecutor.execute(sessionId, toolName, arguments, workspace);
        }

        // CLOUD mode — route to built-in tool
        Tool tool = toolRegistry.getTool(toolName);
        if (tool != null) {
            log.debug("Routing to built-in tool: {} (session={})", toolName, sessionId);
            return tool.execute(arguments, sessionId, workspace);
        }
        throw new IllegalArgumentException("Unknown tool: " + toolName);
    }
}
