package cn.etarch.mao.session.ws;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.auth.service.JwtService;
import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.core.LocalAgentsMdRegistry;
import cn.etarch.mao.harness.shell.ShellSessionManager;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.harness.tool.AskUserQuestionsRegistry;
import cn.etarch.mao.harness.skill.LocalSkillRef;
import cn.etarch.mao.harness.skill.LocalSkillRegistry;
import cn.etarch.mao.harness.skill.SkillSyncService;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.activity.SessionActivityHeartbeat;
import cn.etarch.mao.session.entity.MessageQueue;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.MessageQueueService;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.TaskTerminalService;
import cn.etarch.mao.harness.todo.entity.SessionTodo;
import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Component
public class StreamingWsHandler extends TextWebSocketHandler {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final StreamingWsRegistry registry;
    private final HarnessService harnessService;
    private final SessionService sessionService;
    private final TaskTerminalService taskTerminalService;
    private final MessageQueueService messageQueueService;
    private final LocalToolSessionRegistry localToolSessionRegistry;
    private final AskUserQuestionsRegistry askUserQuestionsRegistry;
    private final ActivityService activityService;
    private final SessionActivityHeartbeat activityHeartbeat;
    private final SessionTodoMapper sessionTodoMapper;
    private final AgentLoop agentLoop;
    private final ShellSessionManager shellSessionManager;
    private final SkillSyncService skillSyncService;
    private final LocalSkillRegistry localSkillRegistry;
    private final LocalAgentsMdRegistry localAgentsMdRegistry;
    private final cn.etarch.mao.harness.mcp.local.McpSyncService mcpSyncService;
    private final cn.etarch.mao.harness.mcp.McpClientManager mcpClientManager;
    private final cn.etarch.mao.permission.service.PermissionService permissionService;
    private final AgentMapper agentMapper;
    private final long mcpSyncTimeoutSeconds;
    private final LlmModelMapper llmModelMapper;
    private final JwtService jwtService;
    private final ExecutorService agentExecutor;

    /** sessionId → cancel flag for running AgentLoops */
    private final ConcurrentHashMap<Long, AtomicBoolean> cancelFlags = new ConcurrentHashMap<>();

    /** sessionId → running agent task future */
    private final ConcurrentHashMap<Long, Future<?>> runningTasks = new ConcurrentHashMap<>();

    /** sessionId → current execution id */
    private final ConcurrentHashMap<Long, String> runningExecutionIds = new ConcurrentHashMap<>();

    /** per-session lock — only one agent execution at a time */
    private final ConcurrentHashMap<Long, Object> sessionLocks = new ConcurrentHashMap<>();

    /** sessionId → pending skill sync future (waiting for client confirmation) */
    private final ConcurrentHashMap<Long, CompletableFuture<Void>> pendingSkillSyncs = new ConcurrentHashMap<>();

    /** sessionId → pending MCP tools report future（含轮次标识 syncId，拒绝迟到报告） */
    private final ConcurrentHashMap<Long, PendingMcpSync> pendingMcpSyncs = new ConcurrentHashMap<>();

    /** 一次 MCP 同步等待：syncId 用于匹配 mcp_tools_report 回传的轮次标识。 */
    private record PendingMcpSync(String syncId, CompletableFuture<Void> future) {}

    /** sessionIds currently in auto-consume flow (skip user_message_saved) */
    private final Set<Long> autoConsumingSessionIds = ConcurrentHashMap.newKeySet();

    /** sessionIds where auto-consume send should be suppressed (insert in progress) */
    private final Set<Long> suppressAutoConsumeSend = ConcurrentHashMap.newKeySet();

    /** per-session lock to serialize concurrent insert_message operations */
    private final ConcurrentHashMap<Long, Object> insertLocks = new ConcurrentHashMap<>();

    private Object getInsertLock(Long sessionId) {
        return insertLocks.computeIfAbsent(sessionId, k -> new Object());
    }

    private Object sessionLock(Long sessionId) {
        return sessionLocks.computeIfAbsent(sessionId, k -> new Object());
    }

    /**
     * Release in-flight local resources when an agent execution ends.
     * Prevents agent threads and desktop clients from staying wedged after failures.
     */
    private void releaseSessionExecutionResources(Long sessionId) {
        if (sessionId == null) {
            return;
        }
        shellSessionManager.closeByConversation(sessionId);
        localToolSessionRegistry.failAllForSession(sessionId);
        askUserQuestionsRegistry.failAllForSession(sessionId);
        localSkillRegistry.clear(sessionId);
        localAgentsMdRegistry.clear(sessionId);
        // 清理 LOCAL 模式 MCP 工具清单缓存（CLOUD 模式连接由 AgentLoop finally 关闭）
        mcpSyncService.clearSession(sessionId);
        // 兜底关闭会话级 MCP 连接（幂等，AgentLoop finally 已执行时无操作）
        mcpClientManager.closeSession(sessionId);
    }

    private boolean isSessionActive(String phase) {
        return "RUNNING".equals(phase) || "RESUMING".equals(phase) || "WAITING_APPROVAL".equals(phase);
    }

    private boolean isSessionCancelled(Long sessionId) {
        Session session = sessionService.getSession(sessionId);
        return session != null && "CANCELLED".equals(session.getPhase());
    }

    private boolean isTerminalPhase(String phase) {
        return "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase);
    }

    private void finishCompletedSession(Long sessionId, Long userId, String executionId) {
        if (isSessionCancelled(sessionId)) {
            log.info("Skip COMPLETED transition for cancelled session {}", sessionId);
            return;
        }
        taskTerminalService.finishExecution(sessionId, userId, "COMPLETED", executionId);
    }

    private void finishFailedSession(Long sessionId, Long userId, String executionId, String failureReason) {
        if (isSessionCancelled(sessionId)) {
            log.info("Skip FAILED transition for cancelled session {}", sessionId);
            return;
        }
        taskTerminalService.finishExecution(sessionId, userId, "FAILED", executionId, failureReason);
    }

    private void abortRunningExecution(Long sessionId, Long userId) {
        abortRunningExecution(sessionId, userId, false);
    }

    private void abortRunningExecution(Long sessionId, Long userId, boolean aggressive) {
        AtomicBoolean flag = cancelFlags.get(sessionId);
        if (flag != null) {
            flag.set(true);
        }
        agentLoop.requestCancel(sessionId);
        shellSessionManager.closeByConversation(sessionId);
        localToolSessionRegistry.failAllForSession(sessionId);

        CompletableFuture<Void> skillSync = pendingSkillSyncs.remove(sessionId);
        if (skillSync != null && !skillSync.isDone()) {
            skillSync.completeExceptionally(new CancellationException("Session aborted"));
        }

        PendingMcpSync mcpSync = pendingMcpSyncs.remove(sessionId);
        if (mcpSync != null && !mcpSync.future().isDone()) {
            mcpSync.future().completeExceptionally(new CancellationException("Session aborted"));
        }

        Future<?> future = runningTasks.get(sessionId);
        if (future != null) {
            future.cancel(aggressive);
        }
        askUserQuestionsRegistry.failAllForSession(sessionId);

        // Propagate cancel to in-flight delegate SUBAGENT children (parent thread may be blocked in DelegateTool)
        abortSubagentChildren(sessionId);
    }

    /**
     * Cancel subagent sessions created by {@code delegate} under this parent.
     * Without this, AgentLoop only watches the child sessionId flag and never sees the parent cancel.
     */
    private void abortSubagentChildren(Long parentSessionId) {
        List<Session> children;
        try {
            children = sessionService.listSubagentSessions(parentSessionId);
        } catch (Exception e) {
            log.warn("Failed to list subagent sessions for parent {}: {}", parentSessionId, e.getMessage());
            return;
        }
        if (children == null || children.isEmpty()) {
            return;
        }
        for (Session child : children) {
            Long childId = child.getId();
            if (childId == null) {
                continue;
            }
            AtomicBoolean childFlag = cancelFlags.get(childId);
            if (childFlag != null) {
                childFlag.set(true);
            }
            agentLoop.requestCancel(childId);
            shellSessionManager.closeByConversation(childId);
            localToolSessionRegistry.failAllForSession(childId);
            askUserQuestionsRegistry.failAllForSession(childId);
            log.info("Propagated cancel to subagent session {} (parent={})", childId, parentSessionId);
        }
    }

    /**
     * Force-terminate a stale session: cancel in-flight work, mark FAILED, and notify the client.
     */
    public void terminateStaleSession(Long sessionId, Long userId) {
        log.warn("Terminating stale session {} for userId={}", sessionId, userId);
        abortRunningExecution(sessionId, userId, true);
        try {
            taskTerminalService.finishExecution(sessionId, userId, "FAILED", UUID.randomUUID().toString(),
                    "任务因长时间无响应已自动终止");
        } catch (Exception e) {
            log.warn("Failed to mark stale session {} as FAILED: {}", sessionId, e.getMessage());
        }
        if (userId != null) {
            registry.send(userId, WsEvent.of("error", sessionId,
                    Map.of("message", "任务因长时间无响应已自动终止")));
        }
        runningTasks.remove(sessionId);
        runningExecutionIds.remove(sessionId);
        // 注意：不要在此移除 cancel flag —— AgentLoop 线程可能还阻塞在工具执行中，
        // 需要保留 flag 使其从阻塞中恢复后能感知取消并停止后续轮次。
        // 清理由执行线程的 finally 块完成（cancelFlags.remove / agentLoop.removeCancelFlag）。
        activityHeartbeat.clear(sessionId);
    }

    public StreamingWsHandler(StreamingWsRegistry registry,
                               HarnessService harnessService,
                               SessionService sessionService,
                               TaskTerminalService taskTerminalService,
                               MessageQueueService messageQueueService,
                               LocalToolSessionRegistry localToolSessionRegistry,
                               AskUserQuestionsRegistry askUserQuestionsRegistry,
                               ActivityService activityService,
                               SessionActivityHeartbeat activityHeartbeat,
                               SessionTodoMapper sessionTodoMapper,
                               AgentLoop agentLoop,
                               ShellSessionManager shellSessionManager,
                               SkillSyncService skillSyncService,
                               LocalSkillRegistry localSkillRegistry,
                               LocalAgentsMdRegistry localAgentsMdRegistry,
                               cn.etarch.mao.harness.mcp.local.McpSyncService mcpSyncService,
                               cn.etarch.mao.harness.mcp.McpClientManager mcpClientManager,
                               cn.etarch.mao.permission.service.PermissionService permissionService,
                               AgentMapper agentMapper,
                               LlmModelMapper llmModelMapper,
                               JwtService jwtService,
                               @Qualifier("agentExecutor") ExecutorService agentExecutor,
                               @Value("${app.mcp.sync-timeout-seconds:60}") long mcpSyncTimeoutSeconds) {
        this.registry = registry;
        this.harnessService = harnessService;
        this.sessionService = sessionService;
        this.taskTerminalService = taskTerminalService;
        this.messageQueueService = messageQueueService;
        this.localToolSessionRegistry = localToolSessionRegistry;
        this.askUserQuestionsRegistry = askUserQuestionsRegistry;
        this.activityService = activityService;
        this.activityHeartbeat = activityHeartbeat;
        this.sessionTodoMapper = sessionTodoMapper;
        this.agentLoop = agentLoop;
        this.shellSessionManager = shellSessionManager;
        this.skillSyncService = skillSyncService;
        this.localSkillRegistry = localSkillRegistry;
        this.localAgentsMdRegistry = localAgentsMdRegistry;
        this.mcpSyncService = mcpSyncService;
        this.mcpClientManager = mcpClientManager;
        this.permissionService = permissionService;
        this.agentMapper = agentMapper;
        this.mcpSyncTimeoutSeconds = mcpSyncTimeoutSeconds;
        this.llmModelMapper = llmModelMapper;
        this.jwtService = jwtService;
        this.agentExecutor = agentExecutor;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        // Extract token from query string — userId resolved from JWT
        Long userId = resolveUserId(session);
        if (userId == null) {
            session.close(CloseStatus.NOT_ACCEPTABLE.withReason("Missing or invalid token"));
            return;
        }
        String clientType = resolveClientType(session);
        registry.register(session, userId, clientType);

        // Send connected confirmation
        registry.send(userId, WsEvent.of("connected", null, Map.of("userId", userId)));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        Long userId = registry.getUserId(session);
        if (userId == null) return;

        JsonNode root;
        try {
            root = objectMapper.readTree(message.getPayload());
        } catch (Exception e) {
            log.warn("Invalid WS message from userId={}: {}", userId, e.getMessage());
            return;
        }

        String type = root.has("type") ? root.get("type").asText() : null;
        if (type == null) return;

        log.debug("WS message type={} from userId={}", type, userId);
        switch (type) {
            case "subscribe" -> handleSubscribe(userId, root);
            case "unsubscribe" -> handleUnsubscribe(userId, root);
            case "send_message" -> handleSendMessage(userId, root, true);
            case "edit_and_resend" -> handleEditAndResend(userId, root);
            case "cancel" -> handleCancel(userId, root);
            case "enqueue_message" -> handleEnqueueMessage(userId, root);
            case "insert_message" -> handleInsertMessage(userId, root);
            case "delete_queue_message" -> handleDeleteQueueMessage(userId, root);
            case "reorder_queue_message" -> handleReorderQueueMessage(userId, root);
            case "skill_sync_done" -> handleSkillSyncDone(userId, root);
            case "mcp_tools_report" -> handleMcpToolsReport(userId, root);
            case "tool_result" -> handleToolResult(userId, root);
            case "tool_error" -> handleToolError(userId, root);
            case "ask_user_questions_result" -> handleAskUserQuestionsResult(userId, root);
            case "create_side_session" -> handleCreateSideSession(userId, root);
            case "cancel_side_task" -> handleCancelSideTask(userId, root);
            case "ping" -> registry.send(userId, WsEvent.of("pong", null, Map.of()));
            default -> log.debug("Unknown WS message type '{}' from userId={}", type, userId);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Long userId = registry.getUserId(session);
        // Collect subscribed session IDs before unregistering (which clears subscriptions)
        Set<Long> subscribedSessionIds = userId != null ? registry.getSubscribedSessionIds(userId) : Set.of();
        registry.unregister(session);
        if (userId != null) {
            if (!registry.hasLocalClientConnection(userId)) {
                localToolSessionRegistry.failAllForUser(userId);
            }
            askUserQuestionsRegistry.failAllForSessions(subscribedSessionIds);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("WS transport error for session={}: {}", session.getId(), exception.getMessage());
        Long userId = registry.getUserId(session);
        Set<Long> subscribedSessionIds = userId != null ? registry.getSubscribedSessionIds(userId) : Set.of();
        registry.unregister(session);
        if (userId != null) {
            if (!registry.hasLocalClientConnection(userId)) {
                localToolSessionRegistry.failAllForUser(userId);
            }
            askUserQuestionsRegistry.failAllForSessions(subscribedSessionIds);
        }
    }

    private void handleSubscribe(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        Session s = requireOwnedSession(userId, sessionId);
        if (s == null) return;

        registry.subscribe(userId, sessionId);
        log.debug("userId={} subscribed to session {}", userId, sessionId);

        // If session is still active (RUNNING / RESUMING / WAITING_APPROVAL), send a snapshot
        // so the client can catch up (e.g. reconnect during tool approval).
        // Also re-register local tool session mapping (handles client reconnect).
        boolean active = isSessionActive(s.getPhase());
        if ("LOCAL".equals(s.getExecutionMode()) && active) {
            localToolSessionRegistry.setUserForSession(sessionId, userId);
        }
        if (active) {
            registry.send(userId, WsEvent.of("session_snapshot", sessionId, Map.of(
                    "phase", s.getPhase()
            )));
        }
    }

    private void handleUnsubscribe(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        // Only remove from caller's own subscription set — no cross-user effect
        registry.unsubscribe(userId, sessionId);
    }

    /**
     * 处理用户发送消息并触发 Agent 执行。
     *
     * @param clearTodos 是否清空上一轮任务清单。
     *                   仅"新任务"场景（直接发消息 / 队列正常消费 / 编辑重发）为 true；
     *                   队列"立即发送打断"（纠偏）为 false，以保留上一轮已拆解的目标与进度。
     */
    private void handleSendMessage(Long userId, JsonNode root, boolean clearTodos) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("content")) return;
        String content = data.get("content").asText();
        String eventId = data.has("eventId") ? data.get("eventId").asText() : null;

        // Parse images from WS message
        List<String> images = new ArrayList<>();
        if (data.has("images") && data.get("images").isArray()) {
            for (JsonNode img : data.get("images")) {
                images.add(img.asText());
            }
        }
        Session session = requireOwnedSession(userId, sessionId);
        if (session == null) return;

        // Abort any in-flight execution so the new message can take over
        if (isSessionActive(session.getPhase())) {
            abortRunningExecution(sessionId, userId);
        }

        // Vision model check: if images are attached, verify model supports vision
        if (!images.isEmpty()) {
            LlmModel model = resolveSessionModel(session);
            if (model == null || model.getSupportsVision() == null || model.getSupportsVision() != 1) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "当前模型不支持图片输入，请切换支持视觉的模型")));
                return;
            }
            // Limit max 10 images per message
            if (images.size() > 10) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "单条消息最多支持 10 张图片")));
                return;
            }
        }

        // For LOCAL mode, register userId and verify desktop client is connected
        if ("LOCAL".equals(session.getExecutionMode())) {
            localToolSessionRegistry.setUserForSession(sessionId, userId);
            if (!localToolSessionRegistry.isConnected(sessionId)) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "Local client is not connected. Please ensure the desktop app is running.")));
                return;
            }
            localSkillRegistry.report(sessionId, parseLocalSkills(data.get("localSkills")));
            // 解析桌面端上报的 AGENTS.md 内容
            localAgentsMdRegistry.report(sessionId, data.path("agentsMdContent").asText(null));
        }

        // Build multimodal content
        Object messageContent;
        if (images.isEmpty()) {
            messageContent = content;
        } else {
            List<ChatRequest.ContentPart> parts = new ArrayList<>();
            if (content != null && !content.isBlank()) {
                parts.add(ChatRequest.ContentPart.builder().type("text").text(content).build());
            }
            for (String imageUrl : images) {
                parts.add(ChatRequest.ContentPart.builder()
                        .type("image_url")
                        .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                        .build());
            }
            messageContent = parts;
        }

        // Save user message to DB (skip if auto-consuming, already saved by autoConsumeQueue)
        boolean isAutoConsume = autoConsumingSessionIds.remove(sessionId);
        if (!isAutoConsume) {
            cn.etarch.mao.session.entity.Message savedMessage = sessionService.saveMessage(sessionId, "USER", messageContent, null, null, null, 0, null);
            // Send real message ID back to client so it can update the optimistic temp ID
            registry.send(userId, WsEvent.of("user_message_saved", sessionId,
                    Map.of("tempEventId", eventId != null ? eventId : "", "messageId", savedMessage.getId())));
        }

        // Prepare event content in cache
        String resolvedEventId = (eventId != null && !eventId.isBlank())
                ? eventId
                : harnessService.prepareMessage(sessionId, messageContent);
        final String executionId = resolvedEventId;

        // Auto-subscribe so the client receives its own events
        registry.subscribe(userId, sessionId);

        // Register cancel flag
        AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);
        cancelFlags.put(sessionId, cancelFlag);

        // Submit agent execution to thread pool
        log.info("Session {} executionMode={}, submitting to agentExecutor", sessionId, session.getExecutionMode());
        runningExecutionIds.put(sessionId, executionId);
        Future<?>[] futureRef = new Future<?>[1];
        futureRef[0] = agentExecutor.submit(() -> {
            synchronized (sessionLock(sessionId)) {
            try {
                sessionService.updatePhase(sessionId, "RUNNING");
                registry.send(userId, WsEvent.of("session_status", sessionId,
                        Map.of("phase", "RUNNING", "executionId", executionId)));
                registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "RUNNING")));

                // LOCAL mode: sync skills to client workspace before agent execution
                if ("LOCAL".equals(session.getExecutionMode())) {
                    Agent agent = agentMapper.selectById(session.getAgentId());
                    if (agent != null) {
                        boolean synced = syncSkillsToClient(userId, sessionId, session, agent);
                        if (!synced) {
                            finishFailedSession(sessionId, userId, executionId, "Skill sync failed or timed out");
                            registry.send(userId, WsEvent.of("error", sessionId,
                                    Map.of("message", "Skill sync failed or timed out")));
                            return;
                        }
                        // LOCAL 模式 MCP 工具清单下发与等待上报（失败降级，不阻塞会话）
                        syncMcpServersToClient(userId, sessionId, session, agent);
                    }
                }

                // CLOUD mode: sync skills to workspace before agent execution
                if ("CLOUD".equals(session.getExecutionMode())) {
                    try {
                        Agent agent = agentMapper.selectById(session.getAgentId());
                        if (agent != null) {
                            skillSyncService.syncToSession(agent, userId, sessionId);
                        }
                    } catch (Exception e) {
                        log.warn("Skill sync to workspace failed for session {}: {}", sessionId, e.getMessage());
                    }
                }

                // Clear previous turn's todos before starting a NEW task.
                // Skipped for queue "send now" (insert_message) which is a correction
                // mid-execution and must preserve the in-progress todo list.
                if (clearTodos) {
                    sessionTodoMapper.delete(
                            new LambdaQueryWrapper<SessionTodo>()
                                    .eq(SessionTodo::getSessionId, sessionId));
                    registry.send(userId, WsEvent.of("todo_updated", sessionId, Map.of("todos", List.of())));
                }

                WsStreamingEventListener listener = new WsStreamingEventListener(
                        registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                        sessionId, userId, executionId, resolveSupportsVision(session));

                harnessService.executeFromEvent(sessionId, resolvedEventId, listener, cancelFlag);

                if (cancelFlag.get()) {
                    finishCancelledSession(sessionId, userId, executionId);
                } else {
                    finishCompletedSession(sessionId, userId, executionId);
                }
            } catch (Throwable e) {
                log.error("[DIAG] Agent execution failed for session {}", sessionId, e);
                try {
                    registry.send(userId, WsEvent.of("error", sessionId,
                            Map.of("message", e.getMessage() != null ? e.getMessage() : "Agent 执行异常",
                                    "executionId", executionId)));
                } catch (Exception ignored) {}
                try {
                    finishFailedSession(sessionId, userId, executionId,
                            e.getMessage() != null ? e.getMessage() : "Agent 执行异常");
                } catch (Exception ignored) {}
            } finally {
                releaseSessionExecutionResources(sessionId);
                runningTasks.remove(sessionId, futureRef[0]);
                runningExecutionIds.remove(sessionId, executionId);
                cancelFlags.remove(sessionId);
                agentLoop.removeCancelFlag(sessionId);
                activityHeartbeat.clear(sessionId);

                // Auto-consume queue: if there are pending messages, send the next one
                autoConsumeQueue(sessionId, userId);
            }
            }
        });
        runningTasks.put(sessionId, futureRef[0]);
    }

    /**
     * Auto-consume the next message from the queue if available.
     * Called after agent execution completes (success, failure, or cancel).
     */
    private void autoConsumeQueue(Long sessionId, Long userId) {
        try {
            // Check if there are pending messages
            List<MessageQueue> queue = messageQueueService.listPending(sessionId);
            if (queue.isEmpty()) return;

            // Skip if an insert_message is in progress for this session
            if (suppressAutoConsumeSend.contains(sessionId)) {
                log.info("Skipping auto-consume for session {} — insert in progress", sessionId);
                return;
            }

            // Dequeue the head message
            MessageQueue head = messageQueueService.dequeue(sessionId);
            if (head == null) return;

            // Notify frontend about queue update
            sendQueueUpdated(sessionId, userId);

            // Verify session is not running (could have been started by another request)
            Session session = sessionService.getSession(sessionId);
            if ("RUNNING".equals(session.getPhase()) || "RESUMING".equals(session.getPhase())) {
                // Re-enqueue if agent is somehow running again
                messageQueueService.enqueue(sessionId, head.getUserId(), head.getContent(), head.getImages());
                sendQueueUpdated(sessionId, userId);
                return;
            }

            // Build content and trigger message send
            String content = head.getContent();
            List<String> imageList = new ArrayList<>();
            if (head.getImages() != null && !head.getImages().isBlank()) {
                try {
                    imageList = objectMapper.readValue(head.getImages(),
                            objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
                } catch (Exception e) {
                    log.warn("Failed to parse images for auto-consume queue item {}: {}", head.getId(), e.getMessage());
                }
            }

            // Build multimodal content for saving
            Object messageContent;
            if (imageList.isEmpty()) {
                messageContent = content;
            } else {
                List<ChatRequest.ContentPart> parts = new ArrayList<>();
                if (content != null && !content.isBlank()) {
                    parts.add(ChatRequest.ContentPart.builder().type("text").text(content).build());
                }
                for (String imageUrl : imageList) {
                    parts.add(ChatRequest.ContentPart.builder()
                            .type("image_url")
                            .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                            .build());
                }
                messageContent = parts;
            }

            // Save user message to DB
            cn.etarch.mao.session.entity.Message savedMessage = sessionService.saveMessage(sessionId, "USER", messageContent, null, null, null, 0, null);

            // Notify frontend: add user message + empty assistant placeholder
            Map<String, Object> consumedData = new java.util.LinkedHashMap<>();
            consumedData.put("messageId", String.valueOf(savedMessage.getId()));
            consumedData.put("content", content);
            if (!imageList.isEmpty()) {
                consumedData.put("images", imageList);
            }
            registry.send(userId, WsEvent.of("queue_message_consumed", sessionId, consumedData));

            // Build a synthetic JsonNode for handleSendMessage
            String eventId = java.util.UUID.randomUUID().toString();
            com.fasterxml.jackson.databind.node.ObjectNode syntheticRoot = objectMapper.createObjectNode();
            syntheticRoot.put("sessionId", sessionId);
            com.fasterxml.jackson.databind.node.ObjectNode syntheticData = objectMapper.createObjectNode();
            syntheticData.put("content", content);
            syntheticData.put("eventId", eventId);
            com.fasterxml.jackson.databind.node.ArrayNode imagesArray = objectMapper.createArrayNode();
            for (String img : imageList) {
                imagesArray.add(img);
            }
            syntheticData.set("images", imagesArray);
            syntheticRoot.set("data", syntheticData);

            // Mark as auto-consuming so handleSendMessage skips duplicate save
            autoConsumingSessionIds.add(sessionId);

            // Short delay to let frontend sync
            agentExecutor.submit(() -> {
                try {
                    Thread.sleep(500);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
                handleSendMessage(userId, syntheticRoot, true);
            });
        } catch (Exception e) {
            log.error("Failed to auto-consume queue for session {}", sessionId, e);
        }
    }

    private void handleEditAndResend(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        Long messageId = getLong(root, "messageId");
        if (sessionId == null || messageId == null) return;

        String content = root.has("content") ? root.get("content").asText() : "";

        // Parse images from WS message
        List<String> images = new ArrayList<>();
        if (root.has("images") && root.get("images").isArray()) {
            for (JsonNode img : root.get("images")) {
                images.add(img.asText());
            }
        }
        Session session = requireOwnedSession(userId, sessionId);
        if (session == null) return;

        // Abort any in-flight execution
        if (isSessionActive(session.getPhase())) {
            abortRunningExecution(sessionId, userId);
        }

        // Validate message is the last user message
        List<cn.etarch.mao.session.entity.Message> messages = sessionService.getMessages(sessionId);
        cn.etarch.mao.session.entity.Message lastUserMsg = messages.stream()
                .filter(m -> "USER".equals(m.getRole()))
                .reduce((a, b) -> b)
                .orElse(null);
        if (lastUserMsg == null || !lastUserMsg.getId().equals(messageId)) {
            registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "只能编辑最后一条用户消息")));
            return;
        }

        // Edit message and truncate subsequent messages
        @SuppressWarnings("unused")
        cn.etarch.mao.session.entity.Message editedMessage;
        try {
            editedMessage = sessionService.editMessageAndTruncate(messageId, content, images);
        } catch (Exception e) {
            registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "编辑消息失败: " + e.getMessage())));
            return;
        }

        // Vision model check: if images are attached, verify model supports vision
        if (!images.isEmpty()) {
            LlmModel model = resolveSessionModel(session);
            if (model == null || model.getSupportsVision() == null || model.getSupportsVision() != 1) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "当前模型不支持图片输入，请切换支持视觉的模型")));
                return;
            }
            if (images.size() > 10) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "单条消息最多支持 10 张图片")));
                return;
            }
        }

        // For LOCAL mode, verify desktop client is connected
        if ("LOCAL".equals(session.getExecutionMode())) {
            localToolSessionRegistry.setUserForSession(sessionId, userId);
            if (!localToolSessionRegistry.isConnected(sessionId)) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "Local client is not connected. Please ensure the desktop app is running.")));
                return;
            }
            localSkillRegistry.report(sessionId, parseLocalSkills(root.get("localSkills")));
            // 解析桌面端上报的 AGENTS.md 内容
            localAgentsMdRegistry.report(sessionId, root.path("agentsMdContent").asText(null));
        }

        // Build multimodal content
        Object messageContent;
        if (images.isEmpty()) {
            messageContent = content;
        } else {
            List<ChatRequest.ContentPart> parts = new ArrayList<>();
            if (content != null && !content.isBlank()) {
                parts.add(ChatRequest.ContentPart.builder().type("text").text(content).build());
            }
            for (String imageUrl : images) {
                parts.add(ChatRequest.ContentPart.builder()
                        .type("image_url")
                        .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                        .build());
            }
            messageContent = parts;
        }

        // Prepare event content in cache
        String resolvedEventId = harnessService.prepareMessage(sessionId, messageContent);
        final String executionId = resolvedEventId;

        // Auto-subscribe so the client receives its own events
        registry.subscribe(userId, sessionId);

        // Register cancel flag
        AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);
        cancelFlags.put(sessionId, cancelFlag);

        // Submit agent execution to thread pool
        log.info("Session {} edit_and_resend, executionMode={}, submitting to agentExecutor", sessionId, session.getExecutionMode());
        runningExecutionIds.put(sessionId, executionId);
        Future<?>[] futureRef = new Future<?>[1];
        futureRef[0] = agentExecutor.submit(() -> {
            synchronized (sessionLock(sessionId)) {
            try {
                sessionService.updatePhase(sessionId, "RUNNING");
                registry.send(userId, WsEvent.of("session_status", sessionId,
                        Map.of("phase", "RUNNING", "executionId", executionId)));
                registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "RUNNING")));

                // LOCAL mode: sync skills to client workspace before agent execution
                if ("LOCAL".equals(session.getExecutionMode())) {
                    Agent agent = agentMapper.selectById(session.getAgentId());
                    if (agent != null) {
                        boolean synced = syncSkillsToClient(userId, sessionId, session, agent);
                        if (!synced) {
                            finishFailedSession(sessionId, userId, executionId, "Skill sync failed or timed out");
                            registry.send(userId, WsEvent.of("error", sessionId,
                                    Map.of("message", "Skill sync failed or timed out")));
                            return;
                        }
                        // LOCAL 模式 MCP 工具清单下发与等待上报（失败降级，不阻塞会话）
                        syncMcpServersToClient(userId, sessionId, session, agent);
                    }
                }

                // CLOUD mode: sync skills to workspace before agent execution
                if ("CLOUD".equals(session.getExecutionMode())) {
                    try {
                        Agent agent = agentMapper.selectById(session.getAgentId());
                        if (agent != null) {
                            skillSyncService.syncToSession(agent, userId, sessionId);
                        }
                    } catch (Exception e) {
                        log.warn("Skill sync to workspace failed for session {}: {}", sessionId, e.getMessage());
                    }
                }

                // Edit-and-resend is a new message (overwrite) — clear previous turn's todos.
                sessionTodoMapper.delete(
                        new LambdaQueryWrapper<SessionTodo>()
                                .eq(SessionTodo::getSessionId, sessionId));
                registry.send(userId, WsEvent.of("todo_updated", sessionId, Map.of("todos", List.of())));

                WsStreamingEventListener listener = new WsStreamingEventListener(
                        registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                        sessionId, userId, executionId, resolveSupportsVision(session));

                harnessService.executeFromEvent(sessionId, resolvedEventId, listener, cancelFlag);

                if (cancelFlag.get()) {
                    finishCancelledSession(sessionId, userId, executionId);
                } else {
                    finishCompletedSession(sessionId, userId, executionId);
                }
            } catch (Throwable e) {
                log.error("[DIAG] Agent execution failed for session {}", sessionId, e);
                try {
                    registry.send(userId, WsEvent.of("error", sessionId,
                            Map.of("message", e.getMessage() != null ? e.getMessage() : "Agent 执行异常",
                                    "executionId", executionId)));
                } catch (Exception ignored) {}
                try {
                    finishFailedSession(sessionId, userId, executionId,
                            e.getMessage() != null ? e.getMessage() : "Agent 执行异常");
                } catch (Exception ignored) {}
            } finally {
                releaseSessionExecutionResources(sessionId);
                runningTasks.remove(sessionId, futureRef[0]);
                runningExecutionIds.remove(sessionId, executionId);
                cancelFlags.remove(sessionId);
                agentLoop.removeCancelFlag(sessionId);
                activityHeartbeat.clear(sessionId);
            }
            }
        });
        runningTasks.put(sessionId, futureRef[0]);
    }

    private void handleToolResult(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        String requestId = root.has("requestId") ? root.get("requestId").asText() : null;
        String result = root.has("result") ? root.get("result").asText() : "{}";
        if (sessionId == null || requestId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;
        localToolSessionRegistry.completeToolRequest(sessionId, requestId, result);
    }

    private void handleToolError(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        String requestId = root.has("requestId") ? root.get("requestId").asText() : null;
        String error = root.has("error") ? root.get("error").asText() : "Unknown error";
        if (sessionId == null || requestId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;
        localToolSessionRegistry.completeToolRequestError(sessionId, requestId, error);
    }

    private void handleAskUserQuestionsResult(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        JsonNode data = root.get("data");
        if (sessionId == null || data == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        String requestId = data.has("requestId") ? data.get("requestId").asText() : null;
        if (requestId == null) return;

        // Pass the answers JSON as-is to the registry
        String answersJson = data.has("answers") ? data.get("answers").toString() : "[]";
        String resultJson = "{\"answers\": " + answersJson + "}";
        askUserQuestionsRegistry.complete(sessionId, requestId, resultJson);
        log.info("Received ask_user_questions_result for session={}, requestId={}", sessionId, requestId);
    }

    /**
     * 创建边路任务会话并执行首条消息。
     * 后续消息复用 handleSendMessage() 标准流程（sessionId = sideSessionId）。
     */
    private void handleCreateSideSession(Long userId, JsonNode root) {
        log.info(">>> handleCreateSideSession called, userId={}, sessionId={}", userId, root.has("sessionId") ? root.get("sessionId").asText() : "null");
        Long parentSessionId = getLong(root, "sessionId");
        if (parentSessionId == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("content")) return;
        String content = data.get("content").asText();
        boolean inheritContext = data.has("inheritContext") && data.get("inheritContext").asBoolean();
        Long modelId = data.has("modelId") && !data.get("modelId").isNull()
                ? data.get("modelId").asLong() : null;

        List<String> images = new ArrayList<>();
        if (data.has("images") && data.get("images").isArray()) {
            for (JsonNode img : data.get("images")) {
                images.add(img.asText());
            }
        }
        if ((content == null || content.isBlank()) && images.isEmpty()) {
            return;
        }

        // 1. 校验主会话存在且归属当前用户
        Session parentSession = requireOwnedSession(userId, parentSessionId);
        if (parentSession == null) return;

        // 2. 确认用户订阅了主会话
        registry.subscribe(userId, parentSessionId);

        // 2.5 LOCAL 模式下校验桌面端已连接，避免创建后才发现无法执行
        if ("LOCAL".equals(parentSession.getExecutionMode()) && !registry.hasLocalClientConnection(userId)) {
            registry.send(userId, WsEvent.of("error", parentSessionId,
                    Map.of("message", "Local client is not connected. Please ensure the desktop app is running.")));
            return;
        }

        // 2.6 Vision model check when images are attached (same rules as send_message)
        Long resolvedModelId = modelId != null ? modelId : parentSession.getModelId();
        if (!images.isEmpty()) {
            Session visionProbe = new Session();
            visionProbe.setModelId(resolvedModelId);
            visionProbe.setAgentId(parentSession.getAgentId());
            LlmModel model = resolveSessionModel(visionProbe);
            if (model == null || model.getSupportsVision() == null || model.getSupportsVision() != 1) {
                registry.send(userId, WsEvent.of("error", parentSessionId,
                        Map.of("message", "当前模型不支持图片输入，请切换支持视觉的模型")));
                return;
            }
            if (images.size() > 10) {
                registry.send(userId, WsEvent.of("error", parentSessionId,
                        Map.of("message", "单条消息最多支持 10 张图片")));
                return;
            }
        }

        // 3. 创建边路任务子会话
        Session sideSession = new Session();
        sideSession.setUserId(userId);
        sideSession.setAgentId(parentSession.getAgentId());
        String titleBody = sessionService.generateTitleFromUserMessage(userId, content);
        if (titleBody == null || titleBody.isBlank()) {
            if (content != null && !content.isBlank()) {
                titleBody = content.length() > 30 ? content.substring(0, 30) + "..." : content;
            } else {
                titleBody = "图片消息";
            }
        }
        sideSession.setTitle(titleBody);
        sideSession.setExecutionMode(parentSession.getExecutionMode());
        sideSession.setWorkspace(parentSession.getWorkspace());
        sideSession.setPermissionLevel(parentSession.getPermissionLevel());
        sideSession.setModelId(resolvedModelId);
        sideSession.setIsGit(parentSession.getIsGit());
        sideSession.setPlatform(parentSession.getPlatform());
        sideSession.setShellPath(parentSession.getShellPath());
        sideSession.setOsVersion(parentSession.getOsVersion());
        sideSession.setStatus("ACTIVE");
        sideSession.setParentSessionId(parentSessionId);
        sideSession.setSessionType("SIDE_TASK");
        sessionService.save(sideSession);
        Long sideSessionId = sideSession.getId();

        // LOCAL 模式：注册本地工具会话映射，并登记桌面端随消息上报的本地未上传 Skill
        if ("LOCAL".equals(sideSession.getExecutionMode())) {
            localToolSessionRegistry.setUserForSession(sideSessionId, userId);
            localSkillRegistry.report(sideSessionId, parseLocalSkills(data.get("localSkills")));
            // 解析桌面端上报的 AGENTS.md 内容
            localAgentsMdRegistry.report(sideSessionId, data.path("agentsMdContent").asText(null));
        }

        log.info("Created side task session {} for parent session {}, userId={}, inheritContext={}",
                sideSessionId, parentSessionId, userId, inheritContext);

        // 4. 保存首条 USER 消息（支持多模态图片）
        cn.etarch.mao.session.entity.Message savedMessage;
        if (images.isEmpty()) {
            savedMessage = sessionService.saveMessage(sideSessionId, "USER", content,
                    null, null, null, 0, null);
        } else {
            List<ChatRequest.ContentPart> parts = new ArrayList<>();
            if (content != null && !content.isBlank()) {
                parts.add(ChatRequest.ContentPart.builder().type("text").text(content).build());
            }
            for (String imageUrl : images) {
                parts.add(ChatRequest.ContentPart.builder()
                        .type("image_url")
                        .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                        .build());
            }
            savedMessage = sessionService.saveMessage(sideSessionId, "USER", parts,
                    null, null, null, 0, null);
        }

        // 5. 通知前端会话已创建（前端随后订阅该 sideSessionId）
        registry.send(userId, WsEvent.of("side_session_created", parentSessionId,
                Map.of("sideSessionId", sideSessionId, "title", sideSession.getTitle())));

        // 5.5 通知前端用户消息已保存
        registry.send(userId, WsEvent.of("user_message_saved", sideSessionId,
                Map.of("messageId", savedMessage.getId())));

        // 6. 注册取消标志
        AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sideSessionId);
        cancelFlags.put(sideSessionId, cancelFlag);
        final String sideExecutionId = UUID.randomUUID().toString();

        // 7. 异步执行首条消息
        runningExecutionIds.put(sideSessionId, sideExecutionId);
        Future<?>[] futureRef = new Future<?>[1];
        futureRef[0] = agentExecutor.submit(() -> {
            synchronized (sessionLock(sideSessionId)) {
            try {
                sessionService.updateField(sideSessionId, "phase", "RUNNING");
                // 通过标准事件通知执行状态（sessionId = sideSessionId，前端需订阅方可见）
                registry.send(userId, WsEvent.of("session_status", sideSessionId,
                        Map.of("phase", "RUNNING", "executionId", sideExecutionId)));

                // LOCAL 模式：Side Task 使用独立的子会话（MCP 工具缓存按 sessionId 隔离），
                // 首条消息前必须同步该子会话的 MCP 工具清单，否则模型无法发现/调用 MCP 工具。
                // 与主消息路径一致：同步失败降级（不阻塞会话），仅该会话无 MCP 工具可用。
                if ("LOCAL".equals(sideSession.getExecutionMode())) {
                    Agent sideAgent = agentMapper.selectById(sideSession.getAgentId());
                    if (sideAgent != null) {
                        syncMcpServersToClient(userId, sideSessionId, sideSession, sideAgent);
                    }
                }

                WsStreamingEventListener listener = new WsStreamingEventListener(
                        registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                        sideSessionId, userId, sideExecutionId, resolveSupportsVision(sideSession));

                harnessService.executeSideFirstMessage(
                        parentSessionId, sideSessionId,
                        inheritContext, listener, cancelFlag);

                if (cancelFlag.get()) {
                    taskTerminalService.finishExecution(sideSessionId, userId, "CANCELLED", sideExecutionId);
                } else {
                    finishCompletedSession(sideSessionId, userId, sideExecutionId);
                }
            } catch (Exception e) {
                log.error("Side task execution failed for sideSession {}", sideSessionId, e);
                try {
                    finishFailedSession(sideSessionId, userId, sideExecutionId,
                            e.getMessage() != null ? e.getMessage() : "未知错误");
                } catch (Exception ignored) {}
                registry.send(userId, WsEvent.of("error", sideSessionId,
                        Map.of("message", e.getMessage() != null ? e.getMessage() : "未知错误")));
            } finally {
                releaseSessionExecutionResources(sideSessionId);
                runningTasks.remove(sideSessionId, futureRef[0]);
                runningExecutionIds.remove(sideSessionId, sideExecutionId);
                cancelFlags.remove(sideSessionId);
                agentLoop.removeCancelFlag(sideSessionId);
                activityHeartbeat.clear(sideSessionId);

                // Auto-consume queue: if there are pending messages, send the next one
                autoConsumeQueue(sideSessionId, userId);
            }
            }
        });
        runningTasks.put(sideSessionId, futureRef[0]);
    }

    /**
     * 取消边路任务。
     */
    private void handleCancelSideTask(Long userId, JsonNode root) {
        Long sideSessionId = getLong(root, "sideSessionId");
        if (sideSessionId == null) return;
        if (requireOwnedSession(userId, sideSessionId) == null) return;

        String executionId = runningExecutionIds.getOrDefault(sideSessionId, "");
        abortRunningExecution(sideSessionId, userId);
        finishCancelledSession(sideSessionId, userId, executionId);
        log.info("Cancel requested for side session {} by userId={}", sideSessionId, userId);
    }

    private void finishCancelledSession(Long sessionId, Long userId, String executionId) {
        // If the session already reached a terminal phase (e.g. the execution thread
        // finished COMPLETED/FAILED, or another cancel already ran), skip cleanup and
        // the phase transition. Avoids deleting the tail twice / overriding a terminal phase.
        Session session = sessionService.getSession(sessionId);
        if (session != null && isTerminalPhase(session.getPhase())) {
            log.info("Skip CANCELLED transition for already-terminal session {} (phase={})",
                    sessionId, session.getPhase());
            return;
        }
        int deleted = sessionService.cleanupIncompleteTail(sessionId);
        if (deleted > 0) {
            log.info("Session {}: cleaned {} incomplete messages after user cancel", sessionId, deleted);
        }
        taskTerminalService.finishExecution(sessionId, userId, "CANCELLED", executionId);
    }

    private void handleCancel(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        String executionId = runningExecutionIds.getOrDefault(sessionId, "");
        abortRunningExecution(sessionId, userId);
        finishCancelledSession(sessionId, userId, executionId);
        log.info("Cancel requested for session {} by userId={}", sessionId, userId);
    }

    // --- Message Queue handlers ---

    private void handleEnqueueMessage(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("content")) return;
        String content = data.get("content").asText();
        String images = null;
        if (data.has("images") && data.get("images").isArray() && data.get("images").size() > 0) {
            images = data.get("images").toString();
        }

        messageQueueService.enqueue(sessionId, userId, content, images);
        sendQueueUpdated(sessionId, userId);
    }

    private void handleInsertMessage(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("queueId")) return;
        Long queueId = data.get("queueId").asLong();
        log.info("handleInsertMessage: session={}, queueId={}", sessionId, queueId);

        // 1. Mark insert in progress — blocks autoConsumeQueue from racing
        suppressAutoConsumeSend.add(sessionId);

        // 2. Abort current agent — handleSendMessage will wait on session lock
        abortRunningExecution(sessionId, userId);

        agentExecutor.submit(() -> {
            synchronized (getInsertLock(sessionId)) {
                try {
                    // Remove from queue
                    MessageQueue item = messageQueueService.getById(queueId);
                    if (item == null || !sessionId.equals(item.getSessionId())) {
                        log.warn("Queue item {} not found or not in session {} for insert", queueId, sessionId);
                        sendQueueUpdated(sessionId, userId);
                        return;
                    }
                    messageQueueService.delete(queueId);
                    sendQueueUpdated(sessionId, userId);
                    String content = item.getContent();
                    List<String> imageList = new ArrayList<>();
                    if (item.getImages() != null && !item.getImages().isBlank()) {
                        try {
                            imageList = objectMapper.readValue(item.getImages(),
                                    objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
                        } catch (Exception e) {
                            log.warn("Failed to parse images for queue item {}: {}", queueId, e.getMessage());
                        }
                    }

                    // Build multimodal content for saving
                    Object messageContent;
                    if (imageList.isEmpty()) {
                        messageContent = content;
                    } else {
                        List<ChatRequest.ContentPart> parts = new ArrayList<>();
                        if (content != null && !content.isBlank()) {
                            parts.add(ChatRequest.ContentPart.builder().type("text").text(content).build());
                        }
                        for (String imageUrl : imageList) {
                            parts.add(ChatRequest.ContentPart.builder()
                                    .type("image_url")
                                    .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                                    .build());
                        }
                        messageContent = parts;
                    }

                    // Save user message to DB
                    cn.etarch.mao.session.entity.Message savedMessage = sessionService.saveMessage(sessionId, "USER", messageContent, null, null, null, 0, null);

                    // Notify frontend: add user message + empty assistant placeholder
                    Map<String, Object> consumedData = new java.util.LinkedHashMap<>();
                    consumedData.put("messageId", String.valueOf(savedMessage.getId()));
                    consumedData.put("content", content);
                    if (!imageList.isEmpty()) {
                        consumedData.put("images", imageList);
                    }
                    registry.send(userId, WsEvent.of("queue_message_consumed", sessionId, consumedData));

                    // Build a synthetic JsonNode for handleSendMessage
                    String eventId = java.util.UUID.randomUUID().toString();
                    com.fasterxml.jackson.databind.node.ObjectNode syntheticRoot = objectMapper.createObjectNode();
                    syntheticRoot.put("sessionId", sessionId);
                    com.fasterxml.jackson.databind.node.ObjectNode syntheticData = objectMapper.createObjectNode();
                    syntheticData.put("content", content);
                    syntheticData.put("eventId", eventId);
                    syntheticData.put("clearTodos", false);
                    com.fasterxml.jackson.databind.node.ArrayNode imagesArray = objectMapper.createArrayNode();
                    for (String img : imageList) {
                        imagesArray.add(img);
                    }
                    syntheticData.set("images", imagesArray);
                    syntheticRoot.set("data", syntheticData);

                    // Mark as auto-consuming so handleSendMessage skips duplicate save
                    autoConsumingSessionIds.add(sessionId);

                    // Clear suppress flag BEFORE calling handleSendMessage so it is not blocked
                    suppressAutoConsumeSend.remove(sessionId);
                    // clearTodos=false: queue "send now" interrupts the running task as a
                    // correction and must preserve the current todo list.
                    log.info("Insert message for session {} — calling handleSendMessage (preserve todos)", sessionId);
                    handleSendMessage(userId, syntheticRoot, false);
                } catch (Exception e) {
                    log.error("Failed to insert message for session {}", sessionId, e);
                } finally {
                    suppressAutoConsumeSend.remove(sessionId);
                }
            }
        });
    }

    private void handleDeleteQueueMessage(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("queueId")) return;
        Long queueId = data.get("queueId").asLong();

        MessageQueue item = messageQueueService.getById(queueId);
        if (item == null || !sessionId.equals(item.getSessionId())) {
            log.warn("Refuse delete queue item {}: missing or not in session {}", queueId, sessionId);
            return;
        }
        messageQueueService.delete(queueId);
        sendQueueUpdated(sessionId, userId);
    }

    private void handleReorderQueueMessage(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("queueId") || !data.has("direction")) return;
        Long queueId = data.get("queueId").asLong();
        String direction = data.get("direction").asText();

        MessageQueue item = messageQueueService.getById(queueId);
        if (item == null || !sessionId.equals(item.getSessionId())) {
            log.warn("Refuse reorder queue item {}: missing or not in session {}", queueId, sessionId);
            return;
        }
        messageQueueService.reorder(queueId, direction);
        sendQueueUpdated(sessionId, userId);
    }

    private void sendQueueUpdated(Long sessionId, Long userId) {
        List<MessageQueue> queue = messageQueueService.listPending(sessionId);
        List<Map<String, Object>> queueData = new ArrayList<>();
        for (MessageQueue item : queue) {
            Map<String, Object> map = new java.util.LinkedHashMap<>();
            map.put("id", String.valueOf(item.getId()));
            map.put("sessionId", String.valueOf(item.getSessionId()));
            map.put("content", item.getContent());
            map.put("sortOrder", item.getSortOrder());
            map.put("createdAt", item.getCreatedAt() != null ? item.getCreatedAt().toString() : null);
            if (item.getImages() != null && !item.getImages().isBlank()) {
                try {
                    map.put("images", objectMapper.readValue(item.getImages(),
                            objectMapper.getTypeFactory().constructCollectionType(List.class, String.class)));
                } catch (Exception e) {
                    // skip images on parse error
                }
            }
            queueData.add(map);
        }
        registry.send(userId, WsEvent.of("queue_updated", sessionId, Map.of("queue", queueData)));
    }

    private LlmModel resolveSessionModel(Session session) {
        Long modelId = session.getModelId();
        if (modelId != null) {
            return llmModelMapper.selectById(modelId);
        }
        return llmModelMapper.selectOne(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<LlmModel>()
                        .eq("is_default", 1).eq("status", 1));
    }

    private boolean resolveSupportsVision(Session session) {
        LlmModel model = resolveSessionModel(session);
        return model != null && model.getSupportsVision() != null && model.getSupportsVision() == 1;
    }

    private Long getLong(JsonNode root, String field) {
        if (!root.has(field) || root.get(field).isNull()) return null;
        try {
            return root.get(field).asLong();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 解析桌面端随消息上报的本地未上传 Skill 列表（LOCAL 模式专用）。
     * 每项形如 {name, description, folderName}，对应 ~/.agents/skills/{folderName}。
     */
    private List<LocalSkillRef> parseLocalSkills(JsonNode node) {
        List<LocalSkillRef> result = new ArrayList<>();
        if (node == null || !node.isArray()) return result;
        for (JsonNode item : node) {
            if (item == null || !item.has("name") || !item.has("folderName")) continue;
            LocalSkillRef ref = new LocalSkillRef();
            ref.setName(item.get("name").asText());
            ref.setFolderName(item.get("folderName").asText());
            ref.setDescription(item.has("description") ? item.get("description").asText() : "");
            result.add(ref);
        }
        return result;
    }

    private Long resolveUserId(WebSocketSession session) {
        String token = getQueryParam(session, "token");
        return token != null ? parseUserIdFromToken(token) : null;
    }

    private String resolveClientType(WebSocketSession session) {
        String client = getQueryParam(session, "client");
        return "electron".equalsIgnoreCase(client) ? "electron" : "browser";
    }

    private String getQueryParam(WebSocketSession session, String key) {
        String query = session.getUri() != null ? session.getUri().getQuery() : null;
        if (query == null) return null;
        for (String param : query.split("&")) {
            String[] kv = param.split("=", 2);
            if (kv.length == 2 && key.equals(kv[0])) {
                return kv[1];
            }
        }
        return null;
    }

    private boolean syncSkillsToClient(Long userId, Long sessionId, Session session, Agent agent) {
        if (!registry.hasLocalClientConnection(userId)) {
            log.warn("Skip skill sync for session {}: no Electron client connected", sessionId);
            return false;
        }

        String syncUrl = "/v1/skills/sync-package?sessionId=" + sessionId;
        List<String> removed = skillSyncService.getRemovedSkillNames(agent, userId, sessionId);
        log.info("Syncing skills to client for session={}, userId={}, syncUrl={}, workspace={}, removed={}", sessionId, userId, syncUrl, session.getWorkspace(), removed);

        CompletableFuture<Void> syncFuture = new CompletableFuture<>();
        pendingSkillSyncs.put(sessionId, syncFuture);
        registry.sendToLocalClients(userId, WsEvent.of("skill_sync_required", sessionId,
                Map.of("syncUrl", syncUrl, "removed", removed, "workspace", session.getWorkspace() != null ? session.getWorkspace() : "")));
        log.info("Sent skill_sync_required to userId={}, sessionId={}", userId, sessionId);

        try {
            syncFuture.get(60, TimeUnit.SECONDS);
            return true;
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            log.warn("Skill sync failed for session {}: {}", sessionId, cause.getMessage());
            return false;
        } finally {
            pendingSkillSyncs.remove(sessionId);
        }
    }

    private void handleSkillSyncDone(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        boolean success = !root.has("success") || root.get("success").asBoolean(true);
        String error = root.has("error") && !root.get("error").isNull() ? root.get("error").asText() : null;
        log.info("Received skill_sync_done from userId={}, sessionId={}, success={}", userId, sessionId, success);
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;
        CompletableFuture<Void> future = pendingSkillSyncs.get(sessionId);
        if (future != null) {
            if (success) {
                future.complete(null);
                log.info("Skill sync confirmed for session {}", sessionId);
            } else {
                String message = (error != null && !error.isBlank()) ? error : "Skill sync failed on client";
                future.completeExceptionally(new RuntimeException(message));
                log.warn("Skill sync failed for session {}: {}", sessionId, message);
            }
        } else {
            log.warn("No pending skill sync future for session={}", sessionId);
        }
    }

    /**
     * LOCAL 模式：下发 Agent 关联的 MCP 服务器配置，并阻塞等待桌面端上报工具清单。
     * 失败降级：不阻塞会话，仅记日志；该会话的 MCP 工具不会被注入（buildContext 读到空清单）。
     */
    private void syncMcpServersToClient(Long userId, Long sessionId, Session session, Agent agent) {
        try {
            // 安全边界：MCP 服务器为管理员级全局配置，仅授予 mcp:read 的用户
            // 才能获得工具清单与环境变量下发。普通用户即使使用管理员创建的 Agent
            // 也无法取得服务器凭据（CLOUD 模式由 buildContext 同样拦截）。
            if (!permissionService.hasPermission(userId, "mcp:read")) {
                log.info("Skip MCP sync for session {}: userId={} lacks mcp:read permission", sessionId, userId);
                mcpSyncService.clearSession(sessionId);
                return;
            }
            var servers = mcpSyncService.loadAgentServers(agent, userId);
            if (servers.isEmpty()) {
                mcpSyncService.clearSession(sessionId);
                return;
            }
            if (!registry.hasLocalClientConnection(userId)) {
                log.warn("Skip MCP sync for session {}: no Electron client connected", sessionId);
                mcpSyncService.clearSession(sessionId);
                return;
            }

            Map<String, Object> payload = mcpSyncService.buildSyncPayload(servers);
            // 每次同步生成唯一轮次标识，随下发携带；回传时匹配，拒绝迟到报告
            String syncId = UUID.randomUUID().toString();
            payload.put("syncId", syncId);
            CompletableFuture<Void> syncFuture = new CompletableFuture<>();
            pendingMcpSyncs.put(sessionId, new PendingMcpSync(syncId, syncFuture));
            registry.sendToLocalClients(userId, WsEvent.of("mcp_sync_required", sessionId, payload));
            log.info("Sent mcp_sync_required to userId={}, sessionId={}, syncId={}, servers={}",
                    userId, sessionId, syncId, servers.stream().map(s -> s.getName()).toList());

            long timeout = mcpSyncTimeoutSeconds;
            syncFuture.get(timeout, TimeUnit.SECONDS);
            log.info("MCP tools report received for session {}", sessionId);
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            log.warn("MCP sync failed for session {}: {}", sessionId, cause.getMessage());
            mcpSyncService.clearSession(sessionId);
        } finally {
            pendingMcpSyncs.remove(sessionId);
        }
    }

    /**
     * 接收桌面端 mcp_tools_report：解析各服务器上报的工具清单，
     * 合并 connected=true 的服务器写入 McpToolsRegistry，并唤醒等待中的同步。
     */
    private void handleMcpToolsReport(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        if (requireOwnedSession(userId, sessionId) == null) return;

        // 轮次校验：只接受与当前等待同步匹配的 syncId，拒绝上一轮超时后的迟到报告
        PendingMcpSync pending = pendingMcpSyncs.get(sessionId);
        String reportSyncId = root.has("syncId") && !root.get("syncId").isNull()
                ? root.get("syncId").asText() : null;
        if (pending == null) {
            log.warn("No pending MCP sync future for session={}, ignoring report", sessionId);
            return;
        }
        if (reportSyncId == null || !reportSyncId.equals(pending.syncId())) {
            log.warn("MCP tools report syncId mismatch for session {}: expected={}, got={}, ignoring",
                    sessionId, pending.syncId(), reportSyncId);
            return;
        }

        List<cn.etarch.mao.harness.mcp.model.McpToolRef> tools = new ArrayList<>();
        JsonNode servers = root.get("servers");
        if (servers != null && servers.isArray()) {
            for (JsonNode serverNode : servers) {
                boolean connected = !serverNode.has("connected") || serverNode.get("connected").asBoolean();
                String name = serverNode.has("name") ? serverNode.get("name").asText() : null;
                if (!connected || name == null || name.isBlank()) {
                    String error = serverNode.has("error") && !serverNode.get("error").isNull()
                            ? serverNode.get("error").asText() : "unknown error";
                    log.warn("MCP server {} unavailable for session {}: {}", name, sessionId, error);
                    continue;
                }
                Long serverId = mcpSyncService.resolveServerIdByName(name);
                JsonNode toolArray = serverNode.get("tools");
                if (toolArray == null || !toolArray.isArray()) {
                    continue;
                }
                for (JsonNode toolNode : toolArray) {
                    String toolName = toolNode.has("name") ? toolNode.get("name").asText() : null;
                    if (toolName == null || toolName.isBlank()) {
                        continue;
                    }
                    String description = toolNode.has("description") && !toolNode.get("description").isNull()
                            ? toolNode.get("description").asText() : "";
                    Map<String, Object> schema = null;
                    if (toolNode.has("schema") && !toolNode.get("schema").isNull()) {
                        try {
                            schema = objectMapper.convertValue(toolNode.get("schema"),
                                    new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
                        } catch (Exception e) {
                            log.warn("Failed to parse MCP tool schema for {}.{}: {}", name, toolName, e.getMessage());
                        }
                    }
                    tools.add(new cn.etarch.mao.harness.mcp.model.McpToolRef(
                            serverId, name, toolName, description,
                            schema != null ? schema : Map.of()));
                }
            }
        }
        mcpSyncService.recordReport(sessionId, tools);
        log.info("Received mcp_tools_report from userId={}, sessionId={}, syncId={}, tools={}",
                userId, sessionId, reportSyncId, tools.size());

        PendingMcpSync current = pendingMcpSyncs.get(sessionId);
        if (current != null && current.syncId().equals(reportSyncId)) {
            current.future().complete(null);
        }
    }

    /**
     * Load session and verify the caller owns it (same semantics as REST {@code requireSessionOwner}).
     * On failure, sends an error WS event and returns null.
     */
    private Session requireOwnedSession(Long userId, Long sessionId) {
        Session session;
        try {
            session = sessionService.getSession(sessionId);
        } catch (Exception e) {
            registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "会话不存在")));
            return null;
        }
        if (session == null || session.getUserId() == null || !session.getUserId().equals(userId)) {
            log.warn("WS ownership denied: userId={} sessionId={} owner={}",
                    userId, sessionId, session != null ? session.getUserId() : null);
            registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "无权操作该会话")));
            return null;
        }
        return session;
    }

    private Long parseUserIdFromToken(String token) {
        try {
            // Must verify signature + expiration — same path as JwtAuthenticationFilter / REST
            if (!jwtService.validateToken(token)) {
                return null;
            }
            return jwtService.getUserIdFromToken(token);
        } catch (Exception e) {
            log.debug("Failed to parse JWT token for WS: {}", e.getMessage());
        }
        return null;
    }

}
