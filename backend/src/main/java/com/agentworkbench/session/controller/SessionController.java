package com.agentworkbench.session.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.session.activity.ActivityService;
import com.agentworkbench.session.activity.SessionActivity;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.MessageQueue;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.service.MessageQueueService;
import com.agentworkbench.session.service.SessionService;
import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/sessions")
public class SessionController {

    private final SessionService sessionService;
    private final AgentMapper agentMapper;
    private final ActivityService activityService;
    private final SessionTodoMapper sessionTodoMapper;
    private final MessageQueueService messageQueueService;

    public SessionController(SessionService sessionService,
                             AgentMapper agentMapper,
                             ActivityService activityService,
                             SessionTodoMapper sessionTodoMapper,
                             MessageQueueService messageQueueService) {
        this.sessionService = sessionService;
        this.agentMapper = agentMapper;
        this.activityService = activityService;
        this.sessionTodoMapper = sessionTodoMapper;
        this.messageQueueService = messageQueueService;
    }

    @PostMapping
    public Result<SessionVO> createSession(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateSessionRequest request) {
        Session session = sessionService.createSession(userId, request.getAgentId(), request.getTitle(),
                request.getExecutionMode(), request.getWorkspace(), request.getPermissionLevel());
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

    @PutMapping("/{id}/read")
    public Result<Void> markAsRead(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        Session session = sessionService.getSession(id);
        if (!session.getUserId().equals(userId)) {
            return Result.fail(403, "无权操作");
        }
        sessionService.markAsRead(id);
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
        if (request.getPermissionLevel() != null) {
            sessionService.updatePermissionLevel(id, request.getPermissionLevel());
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

    @GetMapping("/{id}/messages")
    public Result<List<MessageVO>> getMessages(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        List<Message> messages = sessionService.getMessages(id);
        List<MessageVO> voList = messages.stream().map(this::toMessageVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PatchMapping("/{sessionId}/messages/{messageId}")
    public Result<MessageVO> editMessage(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long sessionId,
            @PathVariable Long messageId,
            @RequestBody EditMessageRequest request) {
        Message edited = sessionService.editMessageAndTruncate(messageId, request.getContent(), request.getImages());
        return Result.ok(toMessageVO(edited));
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

    @GetMapping("/{id}/todos")
    public Result<List<TodoVO>> getTodos(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        List<SessionTodo> todos = sessionTodoMapper.selectList(
                new LambdaQueryWrapper<SessionTodo>()
                        .eq(SessionTodo::getSessionId, id)
                        .orderByAsc(SessionTodo::getSortOrder)
                        .orderByAsc(SessionTodo::getId));
        List<TodoVO> voList = todos.stream().map(this::toTodoVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PatchMapping("/{sessionId}/todos/{todoId}")
    public Result<Void> updateTodo(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long sessionId,
            @PathVariable Long todoId,
            @RequestBody UpdateTodoRequest request) {
        LambdaUpdateWrapper<SessionTodo> wrapper = new LambdaUpdateWrapper<SessionTodo>()
                .eq(SessionTodo::getId, todoId)
                .eq(SessionTodo::getSessionId, sessionId);
        if (request.getStatus() != null) {
            // Enforce single in_progress constraint
            if ("in_progress".equals(request.getStatus())) {
                sessionTodoMapper.update(null,
                        new LambdaUpdateWrapper<SessionTodo>()
                                .eq(SessionTodo::getSessionId, sessionId)
                                .eq(SessionTodo::getStatus, "in_progress")
                                .ne(SessionTodo::getId, todoId)
                                .set(SessionTodo::getStatus, "pending"));
            }
            wrapper.set(SessionTodo::getStatus, request.getStatus());
        }
        if (request.getContent() != null) {
            wrapper.set(SessionTodo::getContent, request.getContent());
        }
        sessionTodoMapper.update(null, wrapper);
        return Result.ok();
    }

    @DeleteMapping("/{sessionId}/todos/{todoId}")
    public Result<Void> deleteTodo(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long sessionId,
            @PathVariable Long todoId) {
        sessionTodoMapper.delete(
                new LambdaQueryWrapper<SessionTodo>()
                        .eq(SessionTodo::getId, todoId)
                        .eq(SessionTodo::getSessionId, sessionId));
        return Result.ok();
    }

    @GetMapping("/{id}/queue")
    public Result<List<QueueMessageVO>> getQueue(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        List<MessageQueue> queue = messageQueueService.listPending(id);
        List<QueueMessageVO> voList = queue.stream().map(this::toQueueMessageVO).toList();
        return Result.ok(voList);
    }

    private TodoVO toTodoVO(SessionTodo todo) {
        TodoVO vo = new TodoVO();
        vo.setId(todo.getId());
        vo.setContent(todo.getContent());
        vo.setStatus(todo.getStatus());
        return vo;
    }

    private QueueMessageVO toQueueMessageVO(MessageQueue item) {
        QueueMessageVO vo = new QueueMessageVO();
        vo.setId(item.getId());
        vo.setSessionId(item.getSessionId());
        vo.setContent(item.getContent());
        vo.setSortOrder(item.getSortOrder());
        vo.setCreatedAt(item.getCreatedAt() != null ? item.getCreatedAt().toString() : null);
        // Parse images JSON
        if (item.getImages() != null && !item.getImages().isBlank()) {
            try {
                vo.setImages(objectMapper.readValue(item.getImages(), new TypeReference<List<String>>() {}));
            } catch (Exception e) {
                log.warn("Failed to parse images JSON for queue item {}", item.getId(), e);
            }
        }
        return vo;
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
        vo.setContextTokens(session.getContextTokens());
        vo.setPermissionLevel(session.getPermissionLevel());
        vo.setRunning("RUNNING".equals(session.getPhase()) || "WAITING_APPROVAL".equals(session.getPhase()));
        vo.setUnread(Integer.valueOf(1).equals(session.getUnread()));

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
        vo.setThinkingContent(message.getThinkingContent());
        vo.setToolCallId(message.getToolCallId());
        vo.setToolCalls(message.getToolCalls());
        vo.setTokenCount(message.getTokenCount());
        vo.setCreatedAt(message.getCreatedAt() != null ? message.getCreatedAt().toString() : null);
        vo.setUpdatedAt(message.getUpdatedAt() != null ? message.getUpdatedAt().toString() : null);

        // Parse multimodal content: JSON array → extract text + images
        String raw = message.getContent();
        if (raw != null && raw.trim().startsWith("[")) {
            try {
                List<?> parts = objectMapper.readValue(raw, new TypeReference<List<?>>() {});
                StringBuilder textSb = new StringBuilder();
                List<String> images = new ArrayList<>();
                for (Object part : parts) {
                    if (part instanceof java.util.Map<?, ?> map) {
                        Object type = map.get("type");
                        if ("text".equals(type)) {
                            Object text = map.get("text");
                            if (text != null) textSb.append(text);
                        } else if ("image_url".equals(type)) {
                            Object imageUrlObj = map.get("image_url");
                            if (imageUrlObj instanceof java.util.Map<?, ?> imgMap) {
                                Object url = imgMap.get("url");
                                if (url != null) images.add(url.toString());
                            }
                        }
                    }
                }
                vo.setContent(textSb.toString());
                if (!images.isEmpty()) {
                    vo.setImages(images);
                }
            } catch (Exception e) {
                vo.setContent(raw);
            }
        } else {
            vo.setContent(raw);
        }

        return vo;
    }

    // DTOs

    @Data
    public static class CreateSessionRequest {
        private Long agentId;
        private String title;
        private String executionMode;
        private String workspace;
        private String permissionLevel;
    }

    @Data
    public static class UpdateSessionRequest {
        private String title;
        private String summary;
        private String projectKey;
        private String permissionLevel;
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
        private Integer contextTokens;
        private Boolean running;
        private Boolean unread;
        private String permissionLevel;
    }

    @Data
    public static class MessageVO {
        private Long id;
        private String role;
        private String content;
        private String thinkingContent;
        private List<String> images;
        private String toolCallId;
        private Object toolCalls;
        private Integer tokenCount;
        private String createdAt;
        private String updatedAt;
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

    @Data
    public static class TodoVO {
        private Long id;
        private String content;
        private String status;
    }

    @Data
    public static class UpdateTodoRequest {
        private String status;
        private String content;
    }

    @Data
    public static class EditMessageRequest {
        private String content;
        private List<String> images;
    }

    @Data
    public static class QueueMessageVO {
        private Long id;
        private Long sessionId;
        private String content;
        private List<String> images;
        private Integer sortOrder;
        private String createdAt;
    }
}
