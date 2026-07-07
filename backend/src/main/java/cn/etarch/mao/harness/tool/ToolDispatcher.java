package cn.etarch.mao.harness.tool;

import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.harness.local.LocalToolExecutor;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.session.entity.PermissionLevel;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Set;

@Slf4j
@Component
public class ToolDispatcher {

    private static final String ASK_USER_QUESTIONS = "ask_user_questions";

    /**
     * 纯服务端工具 —— LOCAL 模式下也由服务端执行，不发给客户端
     */
    private static final Set<String> SERVER_ONLY_TOOLS = Set.of(
            "task_create", "task_update", "task_list", "task_delete", "delegate",
            "web_search", "open_web_page");

    /** Tools that modify files */
    private static final Set<String> WRITE_TOOLS = Set.of("write_file", "edit_file");

    private final ToolRegistry toolRegistry;
    private final LocalToolExecutor localToolExecutor;
    private final DangerAssessor dangerAssessor;
    private final SessionMapper sessionMapper;
    private final StreamingWsRegistry streamingWsRegistry;
    private final AskUserQuestionsRegistry askUserQuestionsRegistry;
    private final LocalToolSessionRegistry localToolSessionRegistry;
    private final ObjectMapper objectMapper;

    public ToolDispatcher(ToolRegistry toolRegistry,
                          LocalToolExecutor localToolExecutor,
                          DangerAssessor dangerAssessor,
                          SessionMapper sessionMapper,
                          StreamingWsRegistry streamingWsRegistry,
                          AskUserQuestionsRegistry askUserQuestionsRegistry,
                          LocalToolSessionRegistry localToolSessionRegistry,
                          ObjectMapper objectMapper) {
        this.toolRegistry = toolRegistry;
        this.localToolExecutor = localToolExecutor;
        this.dangerAssessor = dangerAssessor;
        this.sessionMapper = sessionMapper;
        this.streamingWsRegistry = streamingWsRegistry;
        this.askUserQuestionsRegistry = askUserQuestionsRegistry;
        this.localToolSessionRegistry = localToolSessionRegistry;
        this.objectMapper = objectMapper;
    }

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
        return dispatch(toolName, arguments, executionMode, sessionId, null, workspace,
                permissionLevel, modelConfig);
    }

    public String dispatch(String toolName, String arguments, String executionMode,
                           Long sessionId, Long userId, String workspace,
                           String permissionLevel, LlmModelConfig modelConfig) {
        // ask_user_questions 始终路由到客户端，不受 executionMode 和权限影响
        if (ASK_USER_QUESTIONS.equals(toolName)) {
            return dispatchAskUserQuestions(arguments, sessionId);
        }

        // 纯服务端工具始终在服务端执行，不受 executionMode 影响
        if (SERVER_ONLY_TOOLS.contains(toolName)) {
            Tool tool = toolRegistry.getTool(toolName);
            if (tool != null) {
                log.debug("Routing to server-side tool: {} (session={})", toolName, sessionId);
                return tool.execute(arguments, sessionId, userId, workspace);
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
            return tool.execute(arguments, sessionId, userId, workspace);
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
     * Dispatch ask_user_questions: send question to client via WebSocket and block until answer.
     * Uses LocalToolSessionRegistry for robust userId resolution with sub-agent fallback support.
     */
    private String dispatchAskUserQuestions(String arguments, Long sessionId) {
        // Resolve userId with sub-agent fallback support (consistent with LocalToolSessionRegistry)
        Long userId = localToolSessionRegistry.getUserIdForSession(sessionId);

        // Fallback: if registry doesn't have the session, try direct DB lookup
        if (userId == null) {
            Session session = sessionMapper.selectById(sessionId);
            if (session == null) {
                return "{\"error\": \"Session not found: " + sessionId + "\"}";
            }
            userId = session.getUserId();
        }

        if (userId == null || !streamingWsRegistry.hasConnection(userId)) {
            return "{\"error\": \"No connected client to receive questions\"}";
        }

        // Register pending question
        String requestId = askUserQuestionsRegistry.register(sessionId);

        // Parse arguments to extract questions for the WS payload
        Map<String, Object> data = new java.util.LinkedHashMap<>();
        data.put("requestId", requestId);
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = objectMapper.readValue(arguments, Map.class);
            if (parsed.containsKey("questions")) {
                data.put("questions", parsed.get("questions"));
            }
            if (parsed.containsKey("metadata")) {
                data.put("metadata", parsed.get("metadata"));
            }
        } catch (Exception e) {
            log.warn("Failed to parse ask_user_questions arguments: {}", e.getMessage());
            data.put("questions", List.of());
        }

        // Send to client
        streamingWsRegistry.send(userId, WsEvent.of("ask_user_questions", sessionId, data));
        log.info("Sent ask_user_questions to userId={}, session={}, requestId={}", userId, sessionId, requestId);

        // Block until user responds (with timeout)
        String result = askUserQuestionsRegistry.waitForAnswer(sessionId, requestId);

        // If timed out or errored, notify client to dismiss the question panel
        if (result != null && result.contains("\"error\"")) {
            Map<String, Object> cancelData = new java.util.LinkedHashMap<>();
            cancelData.put("requestId", requestId);
            streamingWsRegistry.send(userId, WsEvent.of("ask_user_questions_cancelled", sessionId, cancelData));
        }

        return result;
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
