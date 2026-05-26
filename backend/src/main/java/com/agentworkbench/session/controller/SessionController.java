package com.agentworkbench.session.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.core.HarnessService;
import com.agentworkbench.harness.local.LocalToolSessionRegistry;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.session.activity.ActivityService;
import com.agentworkbench.session.activity.ActivityTypeMapper;
import com.agentworkbench.session.activity.SessionActivity;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.service.SessionService;
import com.agentworkbench.session.util.ToolResultSummarizer;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/sessions")
public class SessionController {

    private final SessionService sessionService;
    private final HarnessService harnessService;
    private final AgentMapper agentMapper;
    private final LocalToolSessionRegistry localToolSessionRegistry;
    private final ActivityService activityService;
    private final ExecutorService agentExecutor;

    public SessionController(SessionService sessionService, HarnessService harnessService,
                             AgentMapper agentMapper, LocalToolSessionRegistry localToolSessionRegistry,
                             ActivityService activityService,
                             @Value("${app.harness.agent-thread-pool-size:20}") int poolSize,
                             @Value("${app.harness.agent-thread-pool-max:100}") int maxPoolSize,
                             @Value("${app.harness.agent-thread-pool-queue:200}") int queueCapacity) {
        this.sessionService = sessionService;
        this.harnessService = harnessService;
        this.agentMapper = agentMapper;
        this.localToolSessionRegistry = localToolSessionRegistry;
        this.activityService = activityService;
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(poolSize);
        executor.setMaxPoolSize(maxPoolSize);
        executor.setQueueCapacity(queueCapacity);
        executor.setThreadNamePrefix("agent-");
        executor.initialize();
        this.agentExecutor = executor.getThreadPoolExecutor();
    }

    @PostMapping
    public Result<SessionVO> createSession(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateSessionRequest request) {
        Session session = sessionService.createSession(userId, request.getAgentId(), request.getTitle(),
                request.getExecutionMode(), request.getWorkspace());
        return Result.ok(toSessionVO(session));
    }

    @GetMapping
    public Result<List<SessionVO>> listSessions(
            @AuthenticationPrincipal Long userId,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String status) {
        List<Session> sessions = sessionService.listSessions(userId, keyword, status);
        List<SessionVO> voList = sessions.stream().map(this::toSessionVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}")
    public Result<SessionVO> getSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        return Result.ok(toSessionVO(sessionService.getSession(id)));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        sessionService.deleteSession(id);
        return Result.ok();
    }

    @PutMapping("/{id}/pin")
    public Result<Void> togglePin(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        sessionService.togglePin(id);
        return Result.ok();
    }

    @PutMapping("/{id}/favorite")
    public Result<Void> toggleFavorite(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        sessionService.toggleFavorite(id);
        return Result.ok();
    }

    @PutMapping("/{id}/archive")
    public Result<Void> archiveSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        sessionService.archiveSession(id);
        return Result.ok();
    }

    @PatchMapping("/{id}")
    public Result<SessionVO> updateSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody UpdateSessionRequest request) {
        if (request.getTitle() != null) {
            sessionService.updateTitle(id, request.getTitle());
        }
        if (request.getSummary() != null) {
            sessionService.updateSummary(id, request.getSummary());
        }
        if (request.getProjectKey() != null) {
            sessionService.updateProjectKey(id, request.getProjectKey());
        }
        return Result.ok(toSessionVO(sessionService.getSession(id)));
    }

    @GetMapping("/dashboard")
    public Result<Map<String, List<SessionVO>>> dashboard(
            @AuthenticationPrincipal Long userId) {
        Map<String, List<Session>> grouped = sessionService.listSessionsForDashboard(userId);
        Map<String, List<SessionVO>> result = new java.util.HashMap<>();
        result.put("running", grouped.getOrDefault("running", List.of()).stream()
                .map(this::toSessionVO).collect(Collectors.toList()));
        result.put("recent", grouped.getOrDefault("recent", List.of()).stream()
                .map(this::toSessionVO).collect(Collectors.toList()));
        return Result.ok(result);
    }

    @PostMapping("/{id}/messages")
    public Result<SendMessageVO> sendMessage(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody SendMessageRequest request) {
        // Validate session exists
        Session session = sessionService.getSession(id);

        // For LOCAL mode, verify desktop client is connected
        if ("LOCAL".equals(session.getExecutionMode()) && !localToolSessionRegistry.isConnected(id)) {
            return Result.fail(4002, "Local client is not connected. Please start the desktop app and connect to this session.");
        }

        // Save user message to DB immediately
        sessionService.saveMessage(id, "USER", request.getContent(), null, null, 0, null);

        // Prepare event: store content in Redis for stream to pick up
        String eventId = harnessService.prepareMessage(id, request.getContent());

        SendMessageVO vo = new SendMessageVO();
        vo.setEventId(eventId);
        return Result.ok(vo);
    }

    @GetMapping(value = "/{id}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestParam String eventId) {

        SseEmitter emitter = new SseEmitter(30 * 60 * 1000L);

        agentExecutor.submit(() -> {
            try {
                // Track tool call metadata for summary generation
                Map<String, String[]> toolCallInfo = new ConcurrentHashMap<>();

                // Set phase to RUNNING at execution start
                sessionService.updatePhase(id, "RUNNING");
                try {
                    emitter.send(SseEmitter.event()
                            .name("session_status")
                            .data(Map.of("phase", "RUNNING")));
                } catch (Exception ignored) {}

                harnessService.executeFromEvent(id, eventId, new AgentEventListener() {
                    @Override
                    public void onContentDelta(String delta) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("content_delta")
                                    .data(Map.of("delta", delta)));
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
                        try {
                            toolCallInfo.put(toolCall.getId(), new String[]{
                                    toolCall.getFunction().getName(),
                                    toolCall.getFunction().getArguments()
                            });
                            emitter.send(SseEmitter.event()
                                    .name("tool_call_start")
                                    .data(Map.of(
                                            "tool_call_id", toolCall.getId(),
                                            "tool_name", toolCall.getFunction().getName(),
                                            "arguments", toolCall.getFunction().getArguments()
                                    )));
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onToolCallResult(String toolCallId, String result) {
                        try {
                            String[] info = toolCallInfo.remove(toolCallId);
                            String toolName = info != null ? info[0] : null;
                            String arguments = info != null ? info[1] : null;
                            String summary = ToolResultSummarizer.summarize(toolName, arguments, result);

                            Map<String, Object> data = new java.util.LinkedHashMap<>();
                            data.put("tool_call_id", toolCallId);
                            data.put("result", result);
                            if (summary != null) {
                                data.put("summary", summary);
                            }

                            emitter.send(SseEmitter.event()
                                    .name("tool_call_result")
                                    .data(data));

                            // Record activity
                            try {
                                String activityType = ActivityTypeMapper.mapToolToType(toolName);
                                String target = extractActivityTarget(toolName, arguments);
                                String activitySummary = summary != null ? summary : toolName;
                                String status = isErrorResult(result) ? "ERROR" : "SUCCESS";

                                SessionActivity activity = activityService.record(
                                        id, activityType, target, activitySummary, null, status, null);

                                // Send activity SSE event
                                Map<String, Object> activityData = new java.util.LinkedHashMap<>();
                                activityData.put("id", activity.getId());
                                activityData.put("type", activityType);
                                activityData.put("target", target);
                                activityData.put("summary", activitySummary);
                                activityData.put("status", status);

                                emitter.send(SseEmitter.event()
                                        .name("activity")
                                        .data(activityData));
                            } catch (Exception activityEx) {
                                log.warn("Failed to record activity", activityEx);
                            }
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onMessageEnd(ChatUsage usage) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("message_end")
                                    .data(Map.of(
                                            "prompt_tokens", usage.getPromptTokens(),
                                            "completion_tokens", usage.getCompletionTokens(),
                                            "total_tokens", usage.getTotalTokens()
                                    )));
                            // Transition to IDLE on successful completion
                            sessionService.updatePhase(id, "IDLE");
                            emitter.complete();
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onContextCompressed(int messageCount) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("context_compressed")
                                    .data(Map.of("message_count", messageCount)));
                        } catch (Exception e) {
                            log.warn("Failed to send SSE context_compressed event", e);
                        }
                    }

                    @Override
                    public void onError(Throwable t) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("error")
                                    .data(Map.of("message", t.getMessage())));
                            // Transition to FAILED on error
                            try { sessionService.updatePhase(id, "FAILED"); } catch (Exception ignored) {}
                            emitter.completeWithError(t);
                        } catch (Exception e) {
                            log.warn("Failed to send SSE error event", e);
                        }
                    }
                });

            } catch (Exception e) {
                log.error("Agent execution failed", e);
                try {
                    emitter.send(SseEmitter.event()
                            .name("error")
                            .data(Map.of("message", e.getMessage() != null ? e.getMessage() : "Agent 执行异常")));
                } catch (Exception ignored) {}
                try { sessionService.updatePhase(id, "FAILED"); } catch (Exception ignored) {}
                emitter.completeWithError(e);
            }
        });

        emitter.onTimeout(() -> {
            log.warn("SSE connection timed out for session: {}", id);
            try {
                emitter.send(SseEmitter.event()
                        .name("error")
                        .data(Map.of("message", "任务执行超时")));
            } catch (Exception ignored) {}
            try { sessionService.updatePhase(id, "FAILED"); } catch (Exception ignored) {}
            emitter.complete();
        });

        emitter.onError(e -> log.warn("SSE connection error for session: {}", id, e));

        return emitter;
    }

    @GetMapping("/{id}/messages")
    public Result<List<MessageVO>> getMessages(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        List<Message> messages = sessionService.getMessages(id);
        List<MessageVO> voList = messages.stream().map(this::toMessageVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    private static final ObjectMapper objectMapper = new ObjectMapper();

    @GetMapping("/{id}/activities")
    public Result<List<ActivityVO>> getActivities(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestParam(defaultValue = "50") int limit) {
        List<SessionActivity> activities = activityService.listBySession(id, limit);
        List<ActivityVO> voList = activities.stream().map(this::toActivityVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    private ActivityVO toActivityVO(SessionActivity activity) {
        ActivityVO vo = new ActivityVO();
        vo.setId(activity.getId());
        vo.setType(activity.getType());
        vo.setTarget(activity.getTarget());
        vo.setSummary(activity.getSummary());
        vo.setStatus(activity.getStatus());
        vo.setDurationMs(activity.getDurationMs());
        vo.setCreatedAt(activity.getCreatedAt() != null ? activity.getCreatedAt().toString() : null);
        return vo;
    }

    private String extractActivityTarget(String toolName, String arguments) {
        if (toolName == null || arguments == null) return null;
        try {
            com.fasterxml.jackson.databind.JsonNode node = objectMapper.readTree(arguments);
            return switch (toolName.toLowerCase()) {
                case "read_file", "write_file", "edit_file" ->
                        node.has("path") ? node.get("path").asText(null) : null;
                case "bash" -> node.has("command") ? node.get("command").asText(null) : null;
                case "glob", "list" -> node.has("pattern") ? node.get("pattern").asText(null) : null;
                case "http_request" -> node.has("url") ? node.get("url").asText(null) : null;
                default -> null;
            };
        } catch (Exception e) {
            return null;
        }
    }

    private boolean isErrorResult(String result) {
        if (result == null) return false;
        try {
            com.fasterxml.jackson.databind.JsonNode node = objectMapper.readTree(result);
            if (node.has("error")) return true;
            if (node.has("exit_code") && node.get("exit_code").asInt(-1) != 0) return true;
        } catch (Exception ignored) {}
        return false;
    }

    private SessionVO toSessionVO(Session session) {
        SessionVO vo = new SessionVO();
        vo.setId(session.getId());
        vo.setAgentId(session.getAgentId());
        vo.setTitle(session.getTitle());
        vo.setStatus(session.getStatus());
        vo.setIsPinned(session.getIsPinned() != null && session.getIsPinned() == 1);
        vo.setIsFavorite(session.getIsFavorite() != null && session.getIsFavorite() == 1);
        vo.setExecutionMode(session.getExecutionMode());
        vo.setWorkspace(session.getWorkspace());
        vo.setCreatedAt(session.getCreatedAt() != null ? session.getCreatedAt().toString() : null);
        vo.setUpdatedAt(session.getUpdatedAt() != null ? session.getUpdatedAt().toString() : null);

        // Task fields
        vo.setPhase(session.getPhase() != null ? session.getPhase() : "IDLE");
        vo.setSummary(session.getSummary());
        vo.setElapsedMs(session.getElapsedMs() != null ? session.getElapsedMs() : 0);
        vo.setProjectKey(session.getProjectKey());
        vo.setRunning("RUNNING".equals(session.getPhase()) || "WAITING_APPROVAL".equals(session.getPhase()));

        // Parse steps_json
        if (session.getStepsJson() != null && !session.getStepsJson().isBlank()) {
            try {
                vo.setSteps(objectMapper.readValue(session.getStepsJson(), new TypeReference<>() {}));
            } catch (Exception e) {
                log.warn("Failed to parse steps_json for session {}", session.getId(), e);
            }
        }

        // Load agent name
        if (session.getAgentId() != null) {
            Agent agent = agentMapper.selectById(session.getAgentId());
            if (agent != null) {
                vo.setAgentName(agent.getName());
            }
        }
        return vo;
    }

    private MessageVO toMessageVO(Message message) {
        MessageVO vo = new MessageVO();
        vo.setId(message.getId());
        vo.setRole(message.getRole());
        vo.setContent(message.getContent());
        vo.setToolCallId(message.getToolCallId());
        vo.setToolCalls(message.getToolCalls());
        vo.setTokenCount(message.getTokenCount());
        vo.setCreatedAt(message.getCreatedAt() != null ? message.getCreatedAt().toString() : null);
        return vo;
    }

    // DTOs

    @Data
    public static class CreateSessionRequest {
        private Long agentId;
        private String title;
        private String executionMode;
        private String workspace;
    }

    @Data
    public static class SendMessageRequest {
        private String content;
    }

    @Data
    public static class UpdateSessionRequest {
        private String title;
        private String summary;
        private String projectKey;
    }

    @Data
    public static class SendMessageVO {
        private String eventId;
    }

    @Data
    public static class SessionVO {
        private Long id;
        private Long agentId;
        private String agentName;
        private String title;
        private String status;
        private Boolean isPinned;
        private Boolean isFavorite;
        private String executionMode;
        private String workspace;
        private String createdAt;
        private String updatedAt;
        // Task fields
        private String phase;
        private String summary;
        private Long elapsedMs;
        private Object steps;
        private String projectKey;
        private Boolean running;
    }

    @Data
    public static class MessageVO {
        private Long id;
        private String role;
        private String content;
        private String toolCallId;
        private Object toolCalls;
        private Integer tokenCount;
        private String createdAt;
    }

    @Data
    public static class ActivityVO {
        private Long id;
        private String type;
        private String target;
        private String summary;
        private String status;
        private Integer durationMs;
        private String createdAt;
    }
}
