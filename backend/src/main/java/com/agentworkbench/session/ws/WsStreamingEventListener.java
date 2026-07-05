package com.agentworkbench.session.ws;

import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.tool.FileChangeDiffUtil;
import com.agentworkbench.session.activity.ActivityService;
import com.agentworkbench.session.activity.ActivityTypeMapper;
import com.agentworkbench.session.activity.SessionActivity;
import com.agentworkbench.session.activity.SessionActivityHeartbeat;
import com.agentworkbench.session.service.SessionService;
import com.agentworkbench.session.util.ToolResultSummarizer;
import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
    private final SessionActivityHeartbeat activityHeartbeat;
    private final SessionTodoMapper sessionTodoMapper;
    private final SessionService sessionService;
    private final Long sessionId;
    private final Long userId;
    private final String executionId;

    private static final Set<String> TASK_TOOLS = Set.of(
            "task_create", "task_update", "task_delete", "task_list");

    private static final Set<String> FILE_TOOLS = Set.of("write_file", "edit_file");

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** Track tool call metadata for summary generation */
    private final Map<String, String[]> toolCallInfo = new ConcurrentHashMap<>();

    public WsStreamingEventListener(StreamingWsRegistry registry,
                                     ActivityService activityService,
                                     SessionActivityHeartbeat activityHeartbeat,
                                     SessionTodoMapper sessionTodoMapper,
                                     SessionService sessionService,
                                     Long sessionId, Long userId, String executionId) {
        this.registry = registry;
        this.activityService = activityService;
        this.activityHeartbeat = activityHeartbeat;
        this.sessionTodoMapper = sessionTodoMapper;
        this.sessionService = sessionService;
        this.sessionId = sessionId;
        this.userId = userId;
        this.executionId = executionId;
    }

    @Override
    public void onContentDelta(String delta) {
        send("content_delta", Map.of("delta", delta));
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        String args = toolCall.getFunction().getArguments();
        log.debug("[WS] onToolCallStart id={} name={} args={}", toolCall.getId(),
                toolCall.getFunction().getName(),
                args != null ? args.substring(0, Math.min(200, args.length())) : "null");
        toolCallInfo.put(toolCall.getId(), new String[]{
                toolCall.getFunction().getName(),
                args
        });
        send("tool_call_start", Map.of(
                "tool_call_id", toolCall.getId(),
                "tool_name", toolCall.getFunction().getName(),
                "arguments", toolCall.getFunction().getArguments() != null
                        ? toolCall.getFunction().getArguments() : ""
        ));
    }

    @Override
    public void onToolCallResult(String toolCallId, String result) {
        String[] info = toolCallInfo.remove(toolCallId);
        String toolName = info != null ? info[0] : null;
        String arguments = info != null ? info[1] : null;
        String publicResult = FileChangeDiffUtil.stripPrivateDiff(result, objectMapper);
        String summary = ToolResultSummarizer.summarize(toolName, arguments, publicResult);
        log.debug("[WS] onToolCallResult id={} summary={}", toolCallId, summary);
        boolean isError = isErrorResult(publicResult);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("tool_call_id", toolCallId);
        data.put("result", publicResult);
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

        // Push file_change when write_file or edit_file succeeds
        if (FILE_TOOLS.contains(toolName) && !isError) {
            try {
                JsonNode resultNode = objectMapper.readTree(result);
                boolean hasFileChange = resultNode.has("file_change");
                log.info("[FileChange] WS onToolCallResult: toolName={}, hasFileChange={}, resultPreview={}",
                        toolName, hasFileChange, result != null ? result.substring(0, Math.min(200, result.length())) : "null");
                if (hasFileChange && resultNode.path("success").asBoolean()) {
                    JsonNode fc = resultNode.get("file_change");
                    Map<String, Object> changeData = new LinkedHashMap<>();
                    changeData.put("path", fc.get("path").asText());
                    changeData.put("type", fc.get("type").asText());
                    changeData.put("lines_added", fc.get("lines_added").asInt());
                    changeData.put("lines_deleted", fc.get("lines_deleted").asInt());
                    JsonNode diff = resultNode.get(FileChangeDiffUtil.PRIVATE_DIFF_FIELD);
                    if (diff != null && diff.isObject()) {
                        putIfPresent(changeData, "diff_mode", diff, "diff_mode");
                        putIfPresent(changeData, "before_content", diff, "before_content");
                        putIfPresent(changeData, "after_content", diff, "after_content");
                        putIfPresent(changeData, "patch_content", diff, "patch_content");
                        putIfPresent(changeData, "patch_truncated", diff, "patch_truncated");
                        putIfPresent(changeData, "diff_unavailable_reason", diff, "diff_unavailable_reason");
                    }
                    changeData.put("tool_call_id", toolCallId);
                    send("file_change", changeData);
                }
            } catch (Exception e) {
                log.debug("Failed to parse file_change from tool result", e);
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
    public void onContextWindow(int estimatedTokens, int actualTokens) {
        send("context_window", Map.of(
                "estimated", estimatedTokens,
                "actual", actualTokens
        ));
        // Persist the latest context token count
        try {
            sessionService.updateContextTokens(sessionId, estimatedTokens);
        } catch (Exception e) {
            log.warn("Failed to persist context tokens for session {}", sessionId, e);
        }
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

    @Override
    public void onThinkingStart() {
        send("thinking_start", Map.of());
    }

    @Override
    public void onThinkingEnd() {
        send("thinking_end", Map.of());
    }

    @Override
    public void onThinkingDelta(String delta) {
        send("thinking_delta", Map.of("delta", delta));
    }

    @Override
    public void onToolCallArgsDelta(String toolCallId, String arguments) {
        send("tool_call_args_delta", Map.of(
                "tool_call_id", toolCallId,
                "arguments", arguments
        ));
    }

    private void send(String type, Map<String, Object> data) {
        activityHeartbeat.touch(sessionId);
        Map<String, Object> payload = new LinkedHashMap<>(data);
        payload.put("executionId", executionId);
        registry.send(userId, WsEvent.of(type, sessionId, payload));
    }

    private boolean isErrorResult(String result) {
        if (result == null) return false;
        try {
            JsonNode node = objectMapper.readTree(result);
            if (node.has("error")) return true;
            if (node.has("exit_code") && node.get("exit_code").asInt(-1) != 0) return true;
        } catch (Exception ignored) {}
        return false;
    }

    private void putIfPresent(Map<String, Object> target, String key, JsonNode source, String sourceKey) {
        JsonNode node = source.get(sourceKey);
        if (node == null || node.isNull()) return;
        if (node.isBoolean()) {
            target.put(key, node.asBoolean());
        } else {
            target.put(key, node.asText());
        }
    }

    private String extractActivityTarget(String toolName, String arguments) {
        if (toolName == null || arguments == null) return null;
        try {
            JsonNode node = objectMapper.readTree(arguments);
            return switch (toolName.toLowerCase()) {
                case "read_file", "write_file", "edit_file" ->
                        node.has("path") ? node.get("path").asText(null) : null;
                case "shell" -> node.has("command") ? node.get("command").asText(null) : null;
                case "glob", "list" -> node.has("pattern") ? node.get("pattern").asText(null) : null;
                default -> null;
            };
        } catch (Exception e) {
            return null;
        }
    }
}
