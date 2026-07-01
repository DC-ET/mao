package com.agentworkbench.session.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.core.EnvironmentInfoProvider;
import com.agentworkbench.harness.safety.CloudWorkspaceResolver;
import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.core.MessageHistoryNormalizer;
import com.agentworkbench.session.entity.FileChange;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.PermissionLevel;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.FileChangeMapper;
import com.agentworkbench.session.mapper.MessageMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.agentworkbench.session.util.TitleGenerator;
import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.service.UserCommandService;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class SessionService {

    /** Stale threshold: sessions RUNNING longer than this are swept to FAILED */
    private static final int STALE_MINUTES = 10;

    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final FileChangeMapper fileChangeMapper;
    private final AgentMapper agentMapper;
    private final PathSandbox pathSandbox;
    private final ObjectMapper objectMapper;
    private final EnvironmentInfoProvider environmentInfoProvider;
    private final UserCommandService userCommandService;

    public Session createSession(Long userId, Long agentId, String title) {
        return createSession(userId, agentId, title, "CLOUD");
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode) {
        return createSession(userId, agentId, title, executionMode, null);
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode, String workspace) {
        return createSession(userId, agentId, title, executionMode, workspace, null);
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode, String workspace, String permissionLevel) {
        return createSession(userId, agentId, title, executionMode, workspace, permissionLevel, null, null, null, null, null);
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode, String workspace,
                                 String permissionLevel, Boolean isGit, String platform, String shellPath,
                                 String osVersion) {
        return createSession(userId, agentId, title, executionMode, workspace, permissionLevel, isGit, platform, shellPath, osVersion, null, null);
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode, String workspace,
                                 String permissionLevel, Boolean isGit, String platform, String shellPath,
                                 String osVersion, Long modelId) {
        return createSession(userId, agentId, title, executionMode, workspace, permissionLevel, isGit, platform, shellPath, osVersion, modelId, null);
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode, String workspace,
                                 String permissionLevel, Boolean isGit, String platform, String shellPath,
                                 String osVersion, Long modelId, String cloudProjectKey) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        Session session = new Session();
        session.setUserId(userId);
        session.setAgentId(agentId);
        session.setTitle(title != null ? title : "未命名会话");
        session.setStatus("ACTIVE");
        session.setExecutionMode(executionMode != null ? executionMode : "CLOUD");
        if ("CLOUD".equals(session.getExecutionMode())) {
            session.setWorkspace(null);
            session.setProjectKey(null);
        } else {
            session.setWorkspace(workspace);
            session.setProjectKey(deriveProjectKey(workspace));
        }
        session.setPermissionLevel(permissionLevel != null ? permissionLevel : "READ_ONLY");
        session.setIsGit(isGit);
        session.setPlatform(platform);
        session.setShellPath(shellPath);
        session.setOsVersion(osVersion);
        session.setModelId(modelId);
        session.setIsPinned(0);
        session.setIsFavorite(0);
        session.setPhase("IDLE");
        session.setElapsedMs(0L);
        sessionMapper.insert(session);

        if ("CLOUD".equals(session.getExecutionMode())) {
            if (cloudProjectKey != null && !cloudProjectKey.isBlank()) {
                String slug = CloudWorkspaceResolver.normalizeAndValidate(cloudProjectKey);
                String projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(pathSandbox, userId, slug);
                ensureWorkspaceDirectory(projectPath);
                session.setWorkspace(projectPath);
                session.setProjectKey(slug);
                sessionMapper.updateById(session);
            } else {
                String autoPath = pathSandbox.getWorkspaceRoot()
                        .resolve(String.valueOf(userId))
                        .resolve(String.valueOf(session.getId()))
                        .toString();
                ensureWorkspaceDirectory(autoPath);
                session.setWorkspace(autoPath);
                session.setProjectKey(deriveProjectKey(autoPath));
                sessionMapper.updateById(session);
            }
        }

        if ("CLOUD".equals(session.getExecutionMode())) {
            var env = environmentInfoProvider.detect(session.getWorkspace());
            session.setIsGit(env.isGit());
            session.setPlatform(env.platform());
            session.setShellPath(env.shell());
            session.setOsVersion(env.osVersion());
            sessionMapper.updateById(session);
        }

        return session;
    }

    public List<Session> listSessions(Long userId, String keyword, String status) {
        QueryWrapper<Session> qw = new QueryWrapper<>();
        qw.eq("user_id", userId);
        qw.ne("session_type", "SUBAGENT");
        if (keyword != null && !keyword.isEmpty()) {
            qw.and(w -> w.like("title", keyword));
        }
        if (status != null && !status.isEmpty()) {
            qw.eq("status", status);
        } else {
            qw.eq("status", "ACTIVE");
        }
        qw.orderByDesc("is_pinned").orderByDesc("updated_at");
        return sessionMapper.selectList(qw);
    }

    public Page<Session> listSessionsForAdmin(int page, int size, Long userId, Long agentId,
            String executionMode, String phase, String keyword, String status) {
        LambdaQueryWrapper<Session> qw = new LambdaQueryWrapper<>();
        if (userId != null) {
            qw.eq(Session::getUserId, userId);
        }
        if (agentId != null) {
            qw.eq(Session::getAgentId, agentId);
        }
        if (executionMode != null && !executionMode.isEmpty()) {
            qw.eq(Session::getExecutionMode, executionMode);
        }
        if (phase != null && !phase.isEmpty()) {
            qw.eq(Session::getPhase, phase);
        }
        if (keyword != null && !keyword.isEmpty()) {
            qw.and(w -> w.like(Session::getTitle, keyword).or().like(Session::getSummary, keyword));
        }
        qw.eq(Session::getStatus, status != null && !status.isEmpty() ? status : "ACTIVE");
        qw.orderByDesc(Session::getCreatedAt);
        return sessionMapper.selectPage(Page.of(page, size), qw);
    }

    public Session getSession(Long id) {
        Session session = sessionMapper.selectById(id);
        if (session == null) {
            throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
        }
        return session;
    }

    @Transactional
    public void deleteSession(Long id) {
        messageMapper.delete(new QueryWrapper<Message>().eq("session_id", id));
        sessionMapper.deleteById(id);
    }

    public void togglePin(Long id) {
        Session session = getSession(id);
        session.setIsPinned(session.getIsPinned() != null && session.getIsPinned() == 1 ? 0 : 1);
        sessionMapper.updateById(session);
    }

    public void toggleFavorite(Long id) {
        Session session = getSession(id);
        session.setIsFavorite(session.getIsFavorite() != null && session.getIsFavorite() == 1 ? 0 : 1);
        sessionMapper.updateById(session);
    }

    public void archiveSession(Long id) {
        Session session = getSession(id);
        session.setStatus("ARCHIVED");
        sessionMapper.updateById(session);
    }

    public Message saveMessage(Long sessionId, String role, String content, String thinkingContent,
                                String toolCallId, String toolCalls,
                                Integer tokenCount, Long modelId) {
        Message message = new Message();
        message.setSessionId(sessionId);
        message.setRole(role);
        message.setContent(content);
        message.setThinkingContent(thinkingContent);
        message.setToolCallId(toolCallId);
        message.setToolCalls(toolCalls);
        message.setTokenCount(tokenCount != null ? tokenCount : 0);
        message.setModelId(modelId);
        messageMapper.insert(message);

        // Update session's updated_at
        Session session = sessionMapper.selectById(sessionId);
        if (session != null) {
            sessionMapper.updateById(session);
        }

        // Auto-generate title from first user message (skip for sub-agent sessions)
        if ("USER".equals(role) && session != null && !"SUBAGENT".equals(session.getSessionType())) {
            if (session.getTitle() != null && (session.getTitle().equals("未命名会话") || session.getTitle().isBlank())) {
                String textForTitle = preprocessForTitle(content, session.getUserId());
                String autoTitle = TitleGenerator.generate(textForTitle);
                if (autoTitle != null) {
                    session.setTitle(autoTitle);
                    sessionMapper.updateById(session);
                }
            }
        }

        return message;
    }

    public Message saveMessage(Long sessionId, String role, Object content, String thinkingContent,
                                String toolCallId, String toolCalls,
                                Integer tokenCount, Long modelId) {
        Message message = new Message();
        message.setSessionId(sessionId);
        message.setRole(role);
        if (content instanceof String str) {
            message.setContent(str);
        } else if (content != null) {
            try {
                message.setContent(objectMapper.writeValueAsString(content));
            } catch (JsonProcessingException e) {
                log.warn("Failed to serialize content to JSON, storing as string", e);
                message.setContent(content.toString());
            }
        }
        message.setToolCallId(toolCallId);
        message.setToolCalls(toolCalls);
        message.setTokenCount(tokenCount != null ? tokenCount : 0);
        message.setModelId(modelId);
        messageMapper.insert(message);

        // Update session's updated_at
        Session session = sessionMapper.selectById(sessionId);
        if (session != null) {
            sessionMapper.updateById(session);
        }

        // Auto-generate title from first user message (extract text for title, skip for sub-agent sessions)
        if ("USER".equals(role) && session != null && !"SUBAGENT".equals(session.getSessionType())) {
            if (session.getTitle() != null && (session.getTitle().equals("未命名会话") || session.getTitle().isBlank())) {
                String rawText = content instanceof String s ? s : extractTextFromContent(content);
                String textForTitle = preprocessForTitle(rawText, session.getUserId());
                String autoTitle = TitleGenerator.generate(textForTitle);
                if (autoTitle != null) {
                    session.setTitle(autoTitle);
                    sessionMapper.updateById(session);
                }
            }
        }

        return message;
    }

    /**
     * Strip skill markers and expand command markers for title generation.
     */
    private String preprocessForTitle(String text, Long userId) {
        if (text == null) return null;
        Map<String, String> cmdContentMap = Collections.emptyMap();
        if (text.contains("#{") && userId != null) {
            cmdContentMap = userCommandService.listByUserId(userId).stream()
                    .collect(Collectors.toMap(UserCommand::getName, UserCommand::getContent, (a, b) -> a));
        }
        return TitleGenerator.preprocessForTitle(text, cmdContentMap);
    }

    private String extractTextFromContent(Object content) {
        if (content instanceof String s) return s;
        if (content instanceof List<?> list) {
            StringBuilder sb = new StringBuilder();
            for (Object item : list) {
                if (item instanceof Map<?, ?> map) {
                    if ("text".equals(map.get("type"))) {
                        Object text = map.get("text");
                        if (text != null) sb.append(text);
                    }
                }
            }
            return sb.toString();
        }
        return content != null ? content.toString() : "";
    }

    public List<Message> getMessages(Long sessionId) {
        List<Message> messages = messageMapper.selectList(
                new QueryWrapper<Message>()
                        .eq("session_id", sessionId)
                        .orderByAsc("created_at")
                        .orderByAsc("id"));
        return MessageHistoryNormalizer.normalizeEntities(messages, objectMapper);
    }

    public MessagePage getMessagesByRounds(Long sessionId, int roundLimit, Long beforeMessageId) {
        int limit = Math.max(1, Math.min(roundLimit, 50));
        Message beforeMessage = null;
        if (beforeMessageId != null) {
            beforeMessage = messageMapper.selectById(beforeMessageId);
            if (beforeMessage == null || !Objects.equals(beforeMessage.getSessionId(), sessionId)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID);
            }
        }

        LambdaQueryWrapper<Message> userWrapper = new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, sessionId)
                .eq(Message::getRole, "USER")
                .orderByDesc(Message::getId)
                .last("LIMIT " + (limit + 1));
        if (beforeMessage != null) {
            userWrapper.lt(Message::getId, beforeMessage.getId());
        }
        List<Message> userStarts = messageMapper.selectList(userWrapper);
        if (userStarts.isEmpty()) {
            return new MessagePage(List.of(), false, null);
        }

        boolean hasMore = userStarts.size() > limit;
        List<Message> pageStarts = hasMore ? userStarts.subList(0, limit) : userStarts;
        Long startId = pageStarts.get(pageStarts.size() - 1).getId();

        LambdaQueryWrapper<Message> messageWrapper = new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, sessionId)
                .ge(Message::getId, startId)
                .orderByAsc(Message::getCreatedAt)
                .orderByAsc(Message::getId);
        if (beforeMessage != null) {
            messageWrapper.lt(Message::getId, beforeMessage.getId());
        }
        List<Message> messages = MessageHistoryNormalizer.normalizeEntities(
                messageMapper.selectList(messageWrapper), objectMapper);
        Long nextBeforeMessageId = messages.isEmpty() ? null : messages.get(0).getId();
        return new MessagePage(messages, hasMore, nextBeforeMessageId);
    }

    public Map<Long, List<FileChange>> getFileChangesBySession(Long sessionId) {
        List<FileChange> changes = fileChangeMapper.selectList(
                new LambdaQueryWrapper<FileChange>()
                        .eq(FileChange::getSessionId, sessionId)
                        .orderByAsc(FileChange::getId));
        return groupFileChanges(changes);
    }

    public Map<Long, List<FileChange>> getFileChangesByMessageIds(Long sessionId, List<Long> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return Map.of();
        }
        List<FileChange> changes = fileChangeMapper.selectList(
                new LambdaQueryWrapper<FileChange>()
                        .eq(FileChange::getSessionId, sessionId)
                        .in(FileChange::getMessageId, messageIds)
                        .orderByAsc(FileChange::getId));
        return groupFileChanges(changes);
    }

    private Map<Long, List<FileChange>> groupFileChanges(List<FileChange> changes) {
        Map<Long, List<FileChange>> grouped = new LinkedHashMap<>();
        for (FileChange fc : changes) {
            grouped.computeIfAbsent(fc.getMessageId(), k -> new ArrayList<>()).add(fc);
        }
        return grouped;
    }

    public record MessagePage(List<Message> messages, boolean hasMore, Long nextBeforeMessageId) {}

    /**
     * Clean up incomplete tail messages after a crash.
     * When an assistant message has tool_calls but is missing corresponding tool results,
     * the entire incomplete round (assistant + any partial tool results) is removed.
     *
     * Also removes orphaned tool results that appear before the cut point but reference
     * tool_calls from the deleted assistant. This handles the case where a crash occurs
     * during tool execution — tool results are persisted before the assistant message
     * in parallel tool execution, so they can appear earlier in the message sequence.
     *
     * @return number of deleted messages
     */
    public int cleanupIncompleteTail(Long sessionId) {
        List<Message> messages = getMessages(sessionId);
        if (messages.isEmpty()) return 0;

        // Phase 1: Scan from tail to find the first incomplete assistant+tool_calls
        int cutIndex = -1;
        Set<String> missingToolCallIds = Set.of();

        for (int i = messages.size() - 1; i >= 0; i--) {
            Message msg = messages.get(i);
            if ("ASSISTANT".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                Set<String> expectedIds = extractToolCallIds(msg.getToolCalls());
                Set<String> foundIds = new HashSet<>();

                for (int j = i + 1; j < messages.size(); j++) {
                    Message subsequent = messages.get(j);
                    if ("TOOL".equals(subsequent.getRole()) && subsequent.getToolCallId() != null) {
                        foundIds.add(subsequent.getToolCallId());
                    } else if ("ASSISTANT".equals(subsequent.getRole())) {
                        break;
                    }
                }

                if (!foundIds.containsAll(expectedIds)) {
                    cutIndex = i;
                    Set<String> missing = new HashSet<>(expectedIds);
                    missing.removeAll(foundIds);
                    missingToolCallIds = missing;
                    break;
                }
            }
        }

        if (cutIndex < 0) return 0;

        int totalCount = 0;

        // Phase 2: Remove orphaned tool results BEFORE the cut point.
        // During parallel tool execution, tool results are persisted before the assistant
        // message (the assistant is saved after CompletableFuture.allOf().join()).
        // If the crash happens between tool result persistence and assistant persistence,
        // these tool results end up before the assistant in the message sequence.
        // After deleting the assistant, these orphaned tool results would appear as
        // tool messages without a preceding assistant+tool_calls, causing LLM API 400 errors.
        if (!missingToolCallIds.isEmpty()) {
            for (int i = 0; i < cutIndex; i++) {
                Message msg = messages.get(i);
                if ("TOOL".equals(msg.getRole()) && msg.getToolCallId() != null
                        && missingToolCallIds.contains(msg.getToolCallId())) {
                    messageMapper.deleteById(msg.getId());
                    totalCount++;
                }
            }
        }

        // Phase 3: Delete all messages from cutIndex to end
        for (int i = cutIndex; i < messages.size(); i++) {
            messageMapper.deleteById(messages.get(i).getId());
            totalCount++;
        }

        log.info("Session {}: cleaned up {} incomplete messages (cut at index {}, removed {} orphaned tool results before cut)",
                sessionId, totalCount, cutIndex, totalCount - (messages.size() - cutIndex));
        return totalCount;
    }

    /**
     * Extract tool call IDs from a JSON string of tool_calls.
     */
    private Set<String> extractToolCallIds(String toolCallsJson) {
        Set<String> ids = new HashSet<>();
        try {
            com.fasterxml.jackson.databind.JsonNode array = objectMapper.readTree(toolCallsJson);
            if (array.isArray()) {
                for (com.fasterxml.jackson.databind.JsonNode tc : array) {
                    if (tc.has("id") && !tc.get("id").isNull()) {
                        ids.add(tc.get("id").asText());
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Failed to parse tool_calls JSON for tail cleanup: {}", e.getMessage());
        }
        return ids;
    }

    // --- Message edit ---

    /**
     * 编辑用户消息并截断后续消息
     *
     * @param messageId  待编辑的消息ID
     * @param newContent 新的消息内容
     * @param images     新的图片列表（可为空）
     * @return 更新后的消息对象
     * @throws IllegalArgumentException 如果消息不存在或非用户消息
     */
    @Transactional
    public Message editMessageAndTruncate(Long messageId, String newContent, List<String> images) {
        // 1. 查询目标消息，校验 role=USER
        Message message = messageMapper.selectById(messageId);
        if (message == null || !"USER".equals(message.getRole())) {
            throw new IllegalArgumentException("只能编辑用户消息");
        }

        // 2. 更新消息内容
        message.setContent(buildEditContent(newContent, images));
        message.setUpdatedAt(LocalDateTime.now());
        messageMapper.updateById(message);

        // 3. 删除该消息之后的所有消息（按 created_at 降序删除）
        LambdaQueryWrapper<Message> deleteWrapper = new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, message.getSessionId())
                .gt(Message::getCreatedAt, message.getCreatedAt());
        messageMapper.delete(deleteWrapper);

        log.info("Edited message {} in session {}, truncated subsequent messages", messageId, message.getSessionId());
        return message;
    }

    /**
     * 构建编辑后的消息内容（支持纯文本和多模态）
     */
    private String buildEditContent(String text, List<String> images) {
        if (images == null || images.isEmpty()) {
            return text;
        }
        // 多模态内容使用 JSON 数组格式
        List<Map<String, String>> parts = new ArrayList<>();
        parts.add(Map.of("type", "text", "text", text != null ? text : ""));
        for (String imageUrl : images) {
            parts.add(Map.of("type", "image_url", "image_url", imageUrl));
        }
        try {
            return objectMapper.writeValueAsString(parts);
        } catch (JsonProcessingException e) {
            log.warn("Failed to serialize edit content to JSON", e);
            return text;
        }
    }

    // --- Phase management ---

    public void updatePhase(Long sessionId, String phase) {
        Session session = getSession(sessionId);
        String oldPhase = session.getPhase();
        session.setPhase(phase);
        session.setLastActivityAt(LocalDateTime.now());

        if ("RUNNING".equals(phase)) {
            // Only set startedAt if not already set (preserves original start time across recovery)
            if (session.getStartedAt() == null) {
                session.setStartedAt(LocalDateTime.now());
            }
        } else if ("IDLE".equals(phase) || "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase)) {
            // Accumulate elapsed time
            if (session.getStartedAt() != null) {
                long elapsed = Duration.between(session.getStartedAt(), LocalDateTime.now()).toMillis();
                session.setElapsedMs((session.getElapsedMs() != null ? session.getElapsedMs() : 0) + elapsed);
                session.setStartedAt(null);
            }
            // Mark unread when transitioning from non-terminal to terminal phase
            if (!isTerminalPhase(oldPhase) && isTerminalPhase(phase)) {
                session.setUnread(1);
            }
        }

        sessionMapper.updateById(session);
    }

    private boolean isTerminalPhase(String phase) {
        return "IDLE".equals(phase) || "COMPLETED".equals(phase)
            || "FAILED".equals(phase) || "CANCELLED".equals(phase);
    }

    public void markAsRead(Long sessionId) {
        Session session = getSession(sessionId);
        if (Integer.valueOf(1).equals(session.getUnread())) {
            session.setUnread(0);
            sessionMapper.updateById(session);
        }
    }

    public void updateSummary(Long sessionId, String summary) {
        Session session = getSession(sessionId);
        session.setSummary(summary);
        sessionMapper.updateById(session);
    }

    public void updateProjectKey(Long sessionId, String projectKey) {
        Session session = getSession(sessionId);
        session.setProjectKey(projectKey);
        sessionMapper.updateById(session);
    }

    public void updateTitle(Long sessionId, String title) {
        Session session = getSession(sessionId);
        session.setTitle(title);
        sessionMapper.updateById(session);
    }

    public void updatePermissionLevel(Long sessionId, String permissionLevel) {
        PermissionLevel.fromString(permissionLevel); // validate, throws on invalid
        Session session = getSession(sessionId);
        session.setPermissionLevel(permissionLevel);
        sessionMapper.updateById(session);
    }

    public void updateModelId(Long sessionId, Long modelId) {
        Session session = getSession(sessionId);
        session.setModelId(modelId);
        sessionMapper.updateById(session);
    }

    public void updateContextTokens(Long sessionId, int contextTokens) {
        Session session = getSession(sessionId);
        session.setContextTokens(contextTokens);
        sessionMapper.updateById(session);
    }

    public Map<String, List<Session>> listSessionsForDashboard(Long userId) {
        Map<String, List<Session>> result = new java.util.HashMap<>();

        // Running / waiting sessions
        QueryWrapper<Session> runningQw = new QueryWrapper<>();
        runningQw.eq("user_id", userId)
                .eq("status", "ACTIVE")
                .in("phase", Arrays.asList("RUNNING", "RESUMING", "WAITING_APPROVAL"))
                .orderByDesc("last_activity_at");
        result.put("running", sessionMapper.selectList(runningQw));

        // Recent sessions (not running)
        QueryWrapper<Session> recentQw = new QueryWrapper<>();
        recentQw.eq("user_id", userId)
                .eq("status", "ACTIVE")
                .notIn("phase", Arrays.asList("RUNNING", "RESUMING", "WAITING_APPROVAL"))
                .orderByDesc("updated_at")
                .last("LIMIT 20");
        result.put("recent", sessionMapper.selectList(recentQw));

        return result;
    }

    /**
     * Sweep sessions stuck in RUNNING or RESUMING phase beyond the stale threshold.
     * Runs every 60 seconds to catch orphaned sessions from crashes, network drops, etc.
     */
    @Scheduled(fixedRate = 60_000)
    public void sweepStaleRunningSessions() {
        LocalDateTime threshold = LocalDateTime.now().minusMinutes(STALE_MINUTES);
        log.debug("Sweeping stale RUNNING/RESUMING sessions older than {}", threshold);
        UpdateWrapper<Session> uw = new UpdateWrapper<>();
        uw.in("phase", "RUNNING", "RESUMING")
          .and(w -> w.lt("last_activity_at", threshold)
                     .or()
                     .isNull("last_activity_at"));
        Session update = new Session();
        update.setPhase("FAILED");
        int affected = sessionMapper.update(update, uw);
        if (affected > 0) {
            log.warn("Swept {} stale sessions to FAILED (no activity for {}min)", affected, STALE_MINUTES);
        }
    }

    private void ensureWorkspaceDirectory(String path) {
        try {
            Files.createDirectories(Paths.get(path));
        } catch (IOException e) {
            log.error("Failed to create workspace directory: {}", path, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "工作区目录创建失败");
        }
    }

    /** Derive project_key from workspace path (last segment) */
    public static String deriveProjectKey(String workspace) {
        if (workspace == null || workspace.isBlank()) return null;
        String normalized = workspace.replace("\\", "/");
        String[] parts = normalized.split("/");
        for (int i = parts.length - 1; i >= 0; i--) {
            if (!parts[i].isEmpty()) return parts[i];
        }
        return null;
    }
}
