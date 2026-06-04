package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.local.LocalToolExecutor;
import com.agentworkbench.session.entity.PermissionLevel;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.SessionMapper;
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

    /** Tools that modify files */
    private static final Set<String> WRITE_TOOLS = Set.of("write_file", "edit_file");

    private final ToolRegistry toolRegistry;
    private final LocalToolExecutor localToolExecutor;
    private final DangerAssessor dangerAssessor;
    private final SessionMapper sessionMapper;

    private record ApprovalDecision(boolean needApproval, String dangerReason) {}

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
     * Execute a tool call with execution mode routing and permission level control.
     * LOCAL mode: delegates to LocalToolExecutor which sends via WebSocket to desktop client.
     * CLOUD mode: executes on server (default behavior).
     *
     * @param permissionLevel permission level for LOCAL mode approval decisions (nullable, defaults to READ_ONLY)
     * @param modelConfig      LLM model config for SMART mode danger assessment (nullable)
     */
    public String dispatch(String toolName, String arguments, String executionMode,
                           Long sessionId, String workspace,
                           String permissionLevel, LlmModelConfig modelConfig) {
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
            // Always read the latest permissionLevel from DB so mid-execution changes take effect immediately
            String latestPermissionLevel = permissionLevel;
            if (sessionId != null) {
                Session session = sessionMapper.selectById(sessionId);
                if (session != null && session.getPermissionLevel() != null) {
                    latestPermissionLevel = session.getPermissionLevel();
                }
            }
            PermissionLevel level = PermissionLevel.fromString(latestPermissionLevel);
            ApprovalDecision decision = shouldRequireApproval(toolName, level, arguments, modelConfig);
            log.debug("Routing tool call to local executor: {} (session={}, level={}, needApproval={}, reason={})",
                    toolName, sessionId, level, decision.needApproval, decision.dangerReason);
            return localToolExecutor.execute(sessionId, toolName, arguments, workspace, decision.needApproval, decision.dangerReason);
        }

        // CLOUD mode — route to built-in tool
        Tool tool = toolRegistry.getTool(toolName);
        if (tool != null) {
            log.debug("Routing to built-in tool: {} (session={})", toolName, sessionId);
            return tool.execute(arguments, sessionId, workspace);
        }
        throw new IllegalArgumentException("Unknown tool: " + toolName);
    }

    /**
     * Legacy 5-param dispatch (backward compat for non-context callers).
     * Treats as READ_ONLY permission level.
     */
    public String dispatch(String toolName, String arguments, String executionMode, Long sessionId, String workspace) {
        return dispatch(toolName, arguments, executionMode, sessionId, workspace, null, null);
    }

    /**
     * Determine whether a tool call requires user approval based on permission level.
     */
    private ApprovalDecision shouldRequireApproval(String toolName, PermissionLevel level,
                                                   String arguments, LlmModelConfig modelConfig) {
        return switch (level) {
            case READ_ONLY -> new ApprovalDecision(isWriteOrShellTool(toolName), null);
            case READ_WRITE -> new ApprovalDecision("shell".equals(toolName), null);
            case SMART -> {
                if (!"shell".equals(toolName)) yield new ApprovalDecision(false, null);
                if (modelConfig == null) {
                    log.warn("SMART mode: no modelConfig available, defaulting to approval required");
                    yield new ApprovalDecision(true, "无法进行安全评估，默认需要审批");
                }
                DangerAssessor.DangerResult result = dangerAssessor.assess(arguments, modelConfig);
                yield new ApprovalDecision(result.dangerous(), result.reason());
            }
            case FULL -> new ApprovalDecision(false, null);
        };
    }

    private boolean isWriteOrShellTool(String toolName) {
        return "shell".equals(toolName) || WRITE_TOOLS.contains(toolName);
    }
}
