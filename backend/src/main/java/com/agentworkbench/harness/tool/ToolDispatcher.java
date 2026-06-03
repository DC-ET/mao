package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.local.LocalToolExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Set;

@Slf4j
@Component
@RequiredArgsConstructor
public class ToolDispatcher {

    /**
     * 纯服务端工具 —— LOCAL 模式下也由服务端执行，不发给客户端
     */
    private static final Set<String> SERVER_ONLY_TOOLS = Set.of(
            "task_create", "task_update", "task_list", "task_delete");

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
        // 纯服务端工具始终在服务端执行，不受 executionMode 影响
        if (SERVER_ONLY_TOOLS.contains(toolName)) {
            Tool tool = toolRegistry.getTool(toolName);
            if (tool != null) {
                log.debug("Routing to server-side tool: {} (session={})", toolName, sessionId);
                return tool.execute(arguments, sessionId, workspace);
            }
            throw new IllegalArgumentException("Unknown tool: " + toolName);
        }

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
