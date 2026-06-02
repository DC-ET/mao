package com.agentworkbench.session.ws;

import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.session.activity.ActivityService;
import com.agentworkbench.session.activity.ActivityTypeMapper;
import com.agentworkbench.session.activity.SessionActivity;
import com.agentworkbench.session.util.ToolResultSummarizer;
import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
public class WsStreamingEventListener implements AgentEventListener {

    private final StreamingWsRegistry registry;
    private final ActivityService activityService;
    private final SessionTodoMapper sessionTodoMapper;
    private final Long sessionId;
    private final Long userId;

    private static final Set<String> TASK_TOOLS = Set.of(
            "task_create", "task_update", "task_delete", "task_list");

    /** Track tool call metadata for summary generation */
    private final Map<String, String[]> toolCallInfo = new ConcurrentHashMap<>();

    public WsStreamingEventListener(StreamingWsRegistry registry,
                                     ActivityService activityService,
                                     SessionTodoMapper sessionTodoMapper,
                                     Long sessionId, Long userId) {
        this.registry = registry;
        this.activityService = activityService;
        this.sessionTodoMapper = sessionTodoMapper;
        this.sessionId = sessionId;
        this.userId = userId;
    }

    @Override
    public void onContentDelta(String delta) {
        send("content_delta", Map.of("delta", delta));
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        toolCallInfo.put(toolCall.getId(), new String[]{
                toolCall.getFunction().getName(),
                toolCall.getFunction().getArguments()
        });
        send("tool_call_start", Map.of(
                "tool_call_id", toolCall.getId(),
                "tool_name", toolCall.getFunction().getName(),
                "arguments", toolCall.getFunction().getArguments()
        ));
    }

    @Override
    public void onToolCallResult(String toolCallId, String result) {
        String[] info = toolCallInfo.remove(toolCallId);
        String toolName = info != null ? info[0] : null;
        String arguments = info != null ? info[1] : null;
        String summary = ToolResultSummarizer.summarize(toolName, arguments, result);
        boolean isError = isErrorResult(result);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("tool_call_id", toolCallId);
        data.put("result", result);
        data.put("status", isError ? "error" : "success");
        if (summary != null) {
            data.put("summary", summary);
        }
        send("tool_call_result", data);

        // Record activity
        try {
            String activityType = ActivityTypeMapper.mapToolToType(toolName);
            String target = extractActivityTarget(toolName, arguments);
            String activitySummary = summary != null ? summary : toolName;
            String status = isError ? "ERROR" : "SUCCESS";

            SessionActivity activity = activityService.record(
                    sessionId, activityType, target, activitySummary, null, status, null);

            Map<String, Object> activityData = new LinkedHashMap<>();
            activityData.put("id", activity.getId());
            activityData.put("type", activityType);
            activityData.put("target", target);
            activityData.put("summary", activitySummary);
            activityData.put("status", status);
            send("activity", activityData);
        } catch (Exception e) {
            log.warn("Failed to record activity", e);
        }

        // Push todo_updated when any task tool is called
        if (TASK_TOOLS.contains(toolName)) {
            try {
                List<SessionTodo> todos = sessionTodoMapper.selectList(
                        new LambdaQueryWrapper<SessionTodo>()
                                .eq(SessionTodo::getSessionId, sessionId)
                                .orderByAsc(SessionTodo::getId));
                List<Map<String, Object>> todoList = todos.stream()
                        .map(t -> {
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("id", t.getId());
                            m.put("content", t.getContent());
                            m.put("status", t.getStatus());
                            return m;
                        })
                        .collect(Collectors.toList());
                send("todo_updated", Map.of("todos", todoList));
            } catch (Exception e) {
                log.warn("Failed to send todo_updated event", e);
            }
        }
    }

    @Override
    public void onMessageEnd(ChatUsage usage) {
        send("message_end", Map.of(
                "prompt_tokens", usage.getPromptTokens(),
                "completion_tokens", usage.getCompletionTokens(),
                "total_tokens", usage.getTotalTokens()
        ));
    }

    @Override
    public void onError(Throwable t) {
        send("error", Map.of("message", t.getMessage() != null ? t.getMessage() : "Agent 执行异常"));
    }

    @Override
    public void onContextWindow(int estimatedTokens, int actualTokens, int maxTokens) {
        send("context_window", Map.of(
                "estimated", estimatedTokens,
                "actual", actualTokens,
                "maxTokens", maxTokens
        ));
    }

    @Override
    public void onCompactionStart(String type, int messageCount, int estimatedTokens) {
        send("compaction_start", Map.of(
                "type", type,
                "messageCount", messageCount,
                "estimatedTokens", estimatedTokens
        ));
    }

    @Override
    public void onCompactionEnd(String type, int summaryTokens, int savedTokens, long durationMs) {
        send("compaction_end", Map.of(
                "type", type,
                "summaryTokens", summaryTokens,
                "savedTokens", savedTokens,
                "durationMs", durationMs
        ));
    }

    private void send(String type, Map<String, Object> data) {
        registry.send(userId, WsEvent.of(type, sessionId, data));
    }

    private boolean isErrorResult(String result) {
        if (result == null) return false;
        try {
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            com.fasterxml.jackson.databind.JsonNode node = mapper.readTree(result);
            if (node.has("error")) return true;
            if (node.has("exit_code") && node.get("exit_code").asInt(-1) != 0) return true;
        } catch (Exception ignored) {}
        return false;
    }

    private String extractActivityTarget(String toolName, String arguments) {
        if (toolName == null || arguments == null) return null;
        try {
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            com.fasterxml.jackson.databind.JsonNode node = mapper.readTree(arguments);
            return switch (toolName.toLowerCase()) {
                case "read_file", "write_file", "edit_file" ->
                        node.has("path") ? node.get("path").asText(null) : null;
                case "bash" -> node.has("command") ? node.get("command").asText(null) : null;
                case "glob", "list" -> node.has("pattern") ? node.get("pattern").asText(null) : null;
                default -> null;
            };
        } catch (Exception e) {
            return null;
        }
    }
}
