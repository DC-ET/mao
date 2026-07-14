package cn.etarch.mao.session.controller;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.activity.SessionActivity;
import cn.etarch.mao.session.entity.FileChange;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.MessageQueue;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.MessageQueueService;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.harness.todo.entity.SessionTodo;
import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/sessions")
public class SessionController {

    private final SessionService sessionService;
    private final AgentMapper agentMapper;
    private final LlmModelMapper llmModelMapper;
    private final ActivityService activityService;
    private final SessionTodoMapper sessionTodoMapper;
    private final MessageQueueService messageQueueService;
    private final PathSandbox pathSandbox;

    public SessionController(SessionService sessionService,
                             AgentMapper agentMapper,
                             LlmModelMapper llmModelMapper,
                             ActivityService activityService,
                             SessionTodoMapper sessionTodoMapper,
                             MessageQueueService messageQueueService,
                             PathSandbox pathSandbox) {
        this.sessionService = sessionService;
        this.agentMapper = agentMapper;
        this.llmModelMapper = llmModelMapper;
        this.activityService = activityService;
        this.sessionTodoMapper = sessionTodoMapper;
        this.messageQueueService = messageQueueService;
        this.pathSandbox = pathSandbox;
    }

    @PostMapping
    public Result<SessionVO> createSession(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateSessionRequest request) {
        Session session = sessionService.createSession(userId, request.getAgentId(), request.getTitle(),
                request.getExecutionMode(), request.getWorkspace(), request.getPermissionLevel(),
                request.getIsGit(), request.getPlatform(), request.getShell(), request.getOsVersion(),
                request.getModelId(), request.getCloudProjectKey(),
                request.getWorkspaceMode(), request.getGitCloneUrl(), request.getGitBranch());
        return Result.ok(toSessionVO(session, batchLoadAgents(List.of(session)), batchLoadModels(List.of(session))));
    }

    @GetMapping("/cloud-projects")
    public Result<List<CloudProjectVO>> listCloudProjects(
            @AuthenticationPrincipal Long userId) {
        Path userRoot = pathSandbox.getWorkspaceRoot().resolve(String.valueOf(userId));
        Path projectsDir = userRoot.resolve("projects");
        List<CloudProjectVO> projects = new ArrayList<>();

        if (Files.exists(projectsDir)) {
            try (var stream = Files.list(projectsDir)) {
                stream.filter(Files::isDirectory)
                      .map(dir -> {
                          CloudProjectVO vo = new CloudProjectVO();
                          vo.setName(dir.getFileName().toString());
                          vo.setPath(dir.toString());
                          vo.setGit(Files.exists(dir.resolve(".git")));
                          return vo;
                      })
                      .sorted(Comparator.comparing(CloudProjectVO::getName))
                      .forEach(projects::add);
            } catch (IOException e) {
                log.warn("Failed to list cloud projects for user {}: {}", userId, e.getMessage());
            }
        }
        return Result.ok(projects);
    }

    @GetMapping
    public Result<List<SessionVO>> listSessions(
            @AuthenticationPrincipal Long userId,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String status) {
        List<Session> sessions = sessionService.listSessions(userId, keyword, status);

        // Batch-load related entities to avoid N+1 queries
        Map<Long, Agent> agentMap = batchLoadAgents(sessions);
        Map<Long, LlmModel> modelMap = batchLoadModels(sessions);

        List<SessionVO> voList = sessions.stream()
                .map(s -> toSessionVO(s, agentMap, modelMap))
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}")
    public Result<SessionVO> getSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        Session session = requireSessionOwner(userId, id);
        List<Session> single = List.of(session);
        Map<Long, Agent> agentMap = batchLoadAgents(single);
        Map<Long, LlmModel> modelMap = batchLoadModels(single);
        return Result.ok(toSessionVO(session, agentMap, modelMap));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
        sessionService.deleteSession(id);
        return Result.ok();
    }

    @PutMapping("/{id}/pin")
    public Result<Void> togglePin(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
        sessionService.togglePin(id);
        return Result.ok();
    }

    @PutMapping("/{id}/favorite")
    public Result<Void> toggleFavorite(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
        sessionService.toggleFavorite(id);
        return Result.ok();
    }

    @PutMapping("/{id}/archive")
    public Result<Void> archiveSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
        sessionService.archiveSession(id);
        return Result.ok();
    }

    @PutMapping("/{id}/read")
    public Result<Void> markAsRead(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
        sessionService.markAsRead(id);
        return Result.ok();
    }

    @PatchMapping("/{id}")
    public Result<SessionVO> updateSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody UpdateSessionRequest request) {
        requireSessionOwner(userId, id);
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
        if (request.getModelId() != null) {
            sessionService.updateModelId(id, request.getModelId());
        }
        Session updated = sessionService.getSession(id);
        Map<Long, Agent> agentMap = batchLoadAgents(List.of(updated));
        Map<Long, LlmModel> modelMap = batchLoadModels(List.of(updated));
        return Result.ok(toSessionVO(updated, agentMap, modelMap));
    }

    @GetMapping("/dashboard")
    public Result<Map<String, List<SessionVO>>> dashboard(
            @AuthenticationPrincipal Long userId) {
        Map<String, List<Session>> grouped = sessionService.listSessionsForDashboard(userId);

        // Batch-load across all sessions
        List<Session> allSessions = new java.util.ArrayList<>();
        allSessions.addAll(grouped.getOrDefault("running", List.of()));
        allSessions.addAll(grouped.getOrDefault("recent", List.of()));
        Map<Long, Agent> agentMap = batchLoadAgents(allSessions);
        Map<Long, LlmModel> modelMap = batchLoadModels(allSessions);

        Map<String, List<SessionVO>> result = new java.util.HashMap<>();
        result.put("running", grouped.getOrDefault("running", List.of()).stream()
                .map(s -> toSessionVO(s, agentMap, modelMap)).collect(Collectors.toList()));
        result.put("recent", grouped.getOrDefault("recent", List.of()).stream()
                .map(s -> toSessionVO(s, agentMap, modelMap)).collect(Collectors.toList()));
        return Result.ok(result);
    }

    @GetMapping("/{id}/side-tasks")
    public Result<List<SideTaskVO>> listSideTasks(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
        List<Session> sideTasks = sessionService.listSideTaskSessions(id, userId);
        List<SideTaskVO> voList = sideTasks.stream().map(s -> {
            SideTaskVO vo = new SideTaskVO();
            vo.setId(s.getId());
            vo.setTitle(s.getTitle());
            vo.setModelId(s.getModelId());
            vo.setPhase(s.getPhase() != null ? s.getPhase() : "IDLE");
            vo.setCreatedAt(s.getCreatedAt() != null ? s.getCreatedAt().toString() : null);
            return vo;
        }).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}/messages")
    public Result<MessagePageVO> getMessages(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestParam(defaultValue = "5") int roundLimit,
            @RequestParam(required = false) Long beforeMessageId) {
        requireSessionOwner(userId, id);
        SessionService.MessagePage page = sessionService.getMessagesByRounds(id, roundLimit, beforeMessageId);
        List<MessageVO> voList = toMessageVOList(id, page.messages());
        MessagePageVO vo = new MessagePageVO();
        vo.setMessages(voList);
        vo.setHasMore(page.hasMore());
        vo.setNextBeforeMessageId(page.nextBeforeMessageId());
        return Result.ok(vo);
    }

    @PatchMapping("/{sessionId}/messages/{messageId}")
    public Result<MessageVO> editMessage(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long sessionId,
            @PathVariable Long messageId,
            @RequestBody EditMessageRequest request) {
        requireSessionOwner(userId, sessionId);
        Message edited = sessionService.editMessageAndTruncate(messageId, request.getContent(), request.getImages());
        return Result.ok(toMessageVO(edited));
    }

    /**
     * 获取会话并校验当前用户是否为拥有者，不一致则抛出 403。
     */
    private Session requireSessionOwner(Long userId, Long sessionId) {
        Session session = sessionService.getSession(sessionId);
        if (!session.getUserId().equals(userId)) {
            throw new cn.etarch.mao.common.exception.BusinessException(
                    cn.etarch.mao.common.result.ErrorCode.FORBIDDEN, "无权操作该会话");
        }
        return session;
    }

    private static final ObjectMapper objectMapper = new ObjectMapper();

    @GetMapping("/{id}/activities")
    public Result<List<ActivityVO>> getActivities(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestParam(defaultValue = "50") int limit) {
        requireSessionOwner(userId, id);
        List<SessionActivity> activities = activityService.listBySession(id, limit);
        List<ActivityVO> voList = activities.stream().map(this::toActivityVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}/todos")
    public Result<List<TodoVO>> getTodos(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        requireSessionOwner(userId, id);
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
        requireSessionOwner(userId, sessionId);
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
        requireSessionOwner(userId, sessionId);
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
        requireSessionOwner(userId, id);
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

    private Map<Long, Agent> batchLoadAgents(List<Session> sessions) {
        Set<Long> ids = sessions.stream().map(Session::getAgentId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (ids.isEmpty()) return Map.of();
        return agentMapper.selectBatchIds(ids).stream().collect(Collectors.toMap(Agent::getId, a -> a));
    }

    private Map<Long, LlmModel> batchLoadModels(List<Session> sessions) {
        Map<Long, LlmModel> map = new java.util.HashMap<>();
        Set<Long> ids = sessions.stream().map(Session::getModelId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (!ids.isEmpty()) {
            llmModelMapper.selectBatchIds(ids).forEach(m -> map.put(m.getId(), m));
        }
        // Also fetch default model for sessions with no modelId (stored under key 0)
        LlmModel defaultModel = llmModelMapper.selectOne(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<LlmModel>()
                        .eq("is_default", 1).eq("status", 1));
        if (defaultModel != null) {
            map.put(0L, defaultModel);
        }
        return map;
    }

    private SessionVO toSessionVO(Session session, Map<Long, Agent> agentMap, Map<Long, LlmModel> modelMap) {
        SessionVO vo = new SessionVO();
        vo.setId(session.getId());
        vo.setAgentId(session.getAgentId());
        vo.setTitle(session.getTitle());
        vo.setStatus(session.getStatus());
        vo.setIsPinned(session.getIsPinned() != null && session.getIsPinned() == 1);
        vo.setIsFavorite(session.getIsFavorite() != null && session.getIsFavorite() == 1);
        vo.setExecutionMode(session.getExecutionMode());
        vo.setWorkspace(session.getWorkspace());
        vo.setIsGit(session.getIsGit());
        vo.setPlatform(session.getPlatform());
        vo.setShell(session.getShellPath());
        vo.setOsVersion(session.getOsVersion());
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

        // Load agent name from pre-fetched map
        Agent agent = session.getAgentId() != null ? agentMap.get(session.getAgentId()) : null;
        if (agent != null) {
            vo.setAgentName(agent.getName());
        }

        // Load model info — prefer session-level, fallback to default
        LlmModel model = session.getModelId() != null ? modelMap.get(session.getModelId()) : null;
        if (model == null) {
            model = modelMap.get(0L); // default model stored under key 0
        }
        if (model != null) {
            vo.setModelId(model.getId());
            vo.setModelName(model.getName());
            vo.setModelSupportsVision(model.getSupportsVision() != null && model.getSupportsVision() == 1);
        }

        return vo;
    }

    private List<MessageVO> toMessageVOList(Long sessionId, List<Message> messages) {
        List<Long> messageIds = messages.stream().map(Message::getId).collect(Collectors.toList());
        Map<Long, List<FileChange>> changesByMsg = sessionService.getFileChangesByMessageIds(sessionId, messageIds);
        return messages.stream().map(msg -> {
            MessageVO vo = toMessageVO(msg);
            List<FileChange> changes = changesByMsg.get(msg.getId());
            if (changes != null && !changes.isEmpty()) {
                vo.setFileChanges(changes.stream().map(this::toFileChangeVO).collect(Collectors.toList()));
            }
            return vo;
        }).collect(Collectors.toList());
    }

    private MessageVO toMessageVO(Message message) {
        MessageVO vo = new MessageVO();
        vo.setId(message.getId());
        vo.setRole(message.getRole());
        vo.setThinkingContent(message.getThinkingContent());
        vo.setToolCallId(message.getToolCallId());
        vo.setToolCalls(message.getToolCalls());
        vo.setMetadata(message.getMetadata());
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

    private FileChangeVO toFileChangeVO(FileChange fc) {
        FileChangeVO vo = new FileChangeVO();
        vo.setPath(fc.getFilePath());
        vo.setType(fc.getChangeType());
        vo.setLinesAdded(fc.getLinesAdded());
        vo.setLinesDeleted(fc.getLinesDeleted());
        vo.setDiffMode(fc.getDiffMode());
        vo.setBeforeContent(fc.getBeforeContent());
        vo.setAfterContent(fc.getAfterContent());
        vo.setPatchContent(fc.getPatchContent());
        vo.setPatchTruncated(Boolean.TRUE.equals(fc.getPatchTruncated()));
        vo.setDiffUnavailableReason(fc.getDiffUnavailableReason());
        return vo;
    }

    // DTOs

    @Data
    public static class CreateSessionRequest {
        private Long agentId;
        private String title;
        private String executionMode;
        private String workspace;
        private String cloudProjectKey;
        private String workspaceMode;
        private String gitCloneUrl;
        private String gitBranch;
        private String permissionLevel;
        private Long modelId;
        private Boolean isGit;
        private String platform;
        private String shell;
        private String osVersion;
    }

    @Data
    public static class UpdateSessionRequest {
        private String title;
        private String summary;
        private String projectKey;
        private String permissionLevel;
        private Long modelId;
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
        private Boolean isGit;
        private String platform;
        private String shell;
        private String osVersion;
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
        // Model fields
        private Long modelId;
        private String modelName;
        private Boolean modelSupportsVision;
    }

    @Data
    public static class SideTaskVO {
        private Long id;
        private String title;
        private Long modelId;
        private String phase;
        private String createdAt;
    }

    @Data
    public static class MessagePageVO {
        private List<MessageVO> messages;
        private boolean hasMore;
        private Long nextBeforeMessageId;
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
        private String metadata;
        private Integer tokenCount;
        private String createdAt;
        private String updatedAt;
        private List<FileChangeVO> fileChanges;
    }

    @Data
    public static class FileChangeVO {
        private String path;
        private String type;
        private int linesAdded;
        private int linesDeleted;
        private String diffMode;
        private String beforeContent;
        private String afterContent;
        private String patchContent;
        private boolean patchTruncated;
        private String diffUnavailableReason;
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

    @Data
    public static class CloudProjectVO {
        private String name;
        private String path;
        private boolean isGit;
    }
}
