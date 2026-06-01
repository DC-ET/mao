package com.agentworkbench.session.ws;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.harness.core.AgentLoop;
import com.agentworkbench.harness.core.HarnessService;
import com.agentworkbench.harness.local.LocalToolSessionRegistry;
import com.agentworkbench.harness.skill.SkillSyncService;
import com.agentworkbench.session.activity.ActivityService;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.service.SessionService;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Component
public class StreamingWsHandler extends TextWebSocketHandler {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final StreamingWsRegistry registry;
    private final HarnessService harnessService;
    private final SessionService sessionService;
    private final LocalToolSessionRegistry localToolSessionRegistry;
    private final ActivityService activityService;
    private final SessionTodoMapper sessionTodoMapper;
    private final AgentLoop agentLoop;
    private final SkillSyncService skillSyncService;
    private final AgentMapper agentMapper;
    private final ExecutorService agentExecutor;

    /** sessionId → cancel flag for running AgentLoops */
    private final ConcurrentHashMap<Long, AtomicBoolean> cancelFlags = new ConcurrentHashMap<>();

    /** sessionId → pending skill sync future (waiting for client confirmation) */
    private final ConcurrentHashMap<Long, CompletableFuture<Void>> pendingSkillSyncs = new ConcurrentHashMap<>();

    public StreamingWsHandler(StreamingWsRegistry registry,
                               HarnessService harnessService,
                               SessionService sessionService,
                               LocalToolSessionRegistry localToolSessionRegistry,
                               ActivityService activityService,
                               SessionTodoMapper sessionTodoMapper,
                               AgentLoop agentLoop,
                               SkillSyncService skillSyncService,
                               AgentMapper agentMapper,
                               @Value("${app.harness.agent-thread-pool-size:20}") int poolSize,
                               @Value("${app.harness.agent-thread-pool-max:100}") int maxPoolSize,
                               @Value("${app.harness.agent-thread-pool-queue:200}") int queueCapacity) {
        this.registry = registry;
        this.harnessService = harnessService;
        this.sessionService = sessionService;
        this.localToolSessionRegistry = localToolSessionRegistry;
        this.activityService = activityService;
        this.sessionTodoMapper = sessionTodoMapper;
        this.agentLoop = agentLoop;
        this.skillSyncService = skillSyncService;
        this.agentMapper = agentMapper;
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(poolSize);
        executor.setMaxPoolSize(maxPoolSize);
        executor.setQueueCapacity(queueCapacity);
        executor.setThreadNamePrefix("ws-agent-");
        executor.initialize();
        this.agentExecutor = executor.getThreadPoolExecutor();
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        // Extract token from query string — userId resolved from JWT
        Long userId = resolveUserId(session);
        if (userId == null) {
            session.close(CloseStatus.NOT_ACCEPTABLE.withReason("Missing or invalid token"));
            return;
        }
        registry.register(session, userId);

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

        switch (type) {
            case "subscribe" -> handleSubscribe(userId, root);
            case "unsubscribe" -> handleUnsubscribe(userId, root);
            case "send_message" -> handleSendMessage(userId, root);
            case "cancel" -> handleCancel(userId, root);
            case "skill_sync_done" -> handleSkillSyncDone(userId, root);
            case "tool_result" -> handleToolResult(userId, root);
            case "tool_error" -> handleToolError(userId, root);
            case "ping" -> registry.send(userId, WsEvent.of("pong", null, Map.of()));
            default -> log.debug("Unknown WS message type '{}' from userId={}", type, userId);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Long userId = registry.getUserId(session);
        registry.unregister(session);
        if (userId != null) {
            localToolSessionRegistry.failAllForUser(userId);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("WS transport error for session={}: {}", session.getId(), exception.getMessage());
        Long userId = registry.getUserId(session);
        registry.unregister(session);
        if (userId != null) {
            localToolSessionRegistry.failAllForUser(userId);
        }
    }

    private void handleSubscribe(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        registry.subscribe(userId, sessionId);
        log.debug("userId={} subscribed to session {}", userId, sessionId);

        // If session is RUNNING, send a snapshot so the client can catch up
        try {
            Session s = sessionService.getSession(sessionId);
            if (s != null && "RUNNING".equals(s.getPhase())) {
                registry.send(userId, WsEvent.of("session_snapshot", sessionId, Map.of(
                        "phase", "RUNNING"
                )));
            }
        } catch (Exception e) {
            log.debug("Failed to send session_snapshot for session {}: {}", sessionId, e.getMessage());
        }
    }

    private void handleUnsubscribe(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        registry.unsubscribe(userId, sessionId);
    }

    private void handleSendMessage(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;

        JsonNode data = root.get("data");
        if (data == null || !data.has("content")) return;
        String content = data.get("content").asText();
        String eventId = data.has("eventId") ? data.get("eventId").asText() : null;

        // Validate session exists
        Session session;
        try {
            session = sessionService.getSession(sessionId);
        } catch (Exception e) {
            registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "Session not found")));
            return;
        }

        // Check session not already running
        if ("RUNNING".equals(session.getPhase())) {
            registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "Session is already running")));
            return;
        }

        // For LOCAL mode, register userId and verify desktop client is connected
        if ("LOCAL".equals(session.getExecutionMode())) {
            localToolSessionRegistry.setUserForSession(sessionId, userId);
            if (!localToolSessionRegistry.isConnected(sessionId)) {
                registry.send(userId, WsEvent.of("error", sessionId,
                        Map.of("message", "Local client is not connected. Please ensure the desktop app is running.")));
                return;
            }
        }

        // Save user message to DB
        sessionService.saveMessage(sessionId, "USER", content, null, null, 0, null);

        // Prepare event content in cache
        String resolvedEventId = (eventId != null && !eventId.isBlank())
                ? eventId
                : harnessService.prepareMessage(sessionId, content);

        // Auto-subscribe so the client receives its own events
        registry.subscribe(userId, sessionId);

        // Register cancel flag
        AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);
        cancelFlags.put(sessionId, cancelFlag);

        // Submit agent execution to thread pool
        log.info("Session {} executionMode={}, submitting to agentExecutor", sessionId, session.getExecutionMode());
        agentExecutor.submit(() -> {
            try {
                sessionService.updatePhase(sessionId, "RUNNING");
                registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "RUNNING")));
                registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "RUNNING")));

                // LOCAL mode: sync skills to client workspace before agent execution
                if ("LOCAL".equals(session.getExecutionMode())) {
                    Agent agent = agentMapper.selectById(session.getAgentId());
                    if (agent != null) {
                        boolean synced = syncSkillsToClient(userId, sessionId, session, agent);
                        if (!synced) {
                            sessionService.updatePhase(sessionId, "FAILED");
                            registry.send(userId, WsEvent.of("error", sessionId,
                                    Map.of("message", "Skill sync failed or timed out")));
                            registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "FAILED")));
                            registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "FAILED")));
                            return;
                        }
                    }
                }

                // CLOUD mode: sync skills to workspace before agent execution
                if ("CLOUD".equals(session.getExecutionMode())) {
                    try {
                        Agent agent = agentMapper.selectById(session.getAgentId());
                        if (agent != null) {
                            skillSyncService.syncToWorkspace(agent, session.getWorkspace());
                        }
                    } catch (Exception e) {
                        log.warn("Skill sync to workspace failed for session {}: {}", sessionId, e.getMessage());
                    }
                }

                WsStreamingEventListener listener = new WsStreamingEventListener(
                        registry, activityService, sessionTodoMapper, sessionId, userId);

                harnessService.executeFromEvent(sessionId, resolvedEventId, listener, cancelFlag);

                if (cancelFlag.get()) {
                    sessionService.updatePhase(sessionId, "CANCELLED");
                    registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "CANCELLED")));
                    registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "CANCELLED")));
                } else {
                    sessionService.updatePhase(sessionId, "COMPLETED");
                    registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "COMPLETED")));
                    registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "COMPLETED")));
                }
            } catch (Exception e) {
                log.error("Agent execution failed for session {}", sessionId, e);
                try {
                    registry.send(userId, WsEvent.of("error", sessionId,
                            Map.of("message", e.getMessage() != null ? e.getMessage() : "Agent 执行异常")));
                } catch (Exception ignored) {}
                try {
                    sessionService.updatePhase(sessionId, "FAILED");
                } catch (Exception ignored) {}
                registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "FAILED")));
                registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "FAILED")));
            } finally {
                cancelFlags.remove(sessionId);
                agentLoop.removeCancelFlag(sessionId);
            }
        });
    }

    private void handleToolResult(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        String requestId = root.has("requestId") ? root.get("requestId").asText() : null;
        String result = root.has("result") ? root.get("result").toString() : "{}";
        if (sessionId != null && requestId != null) {
            localToolSessionRegistry.completeToolRequest(sessionId, requestId, result);
        }
    }

    private void handleToolError(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        String requestId = root.has("requestId") ? root.get("requestId").asText() : null;
        String error = root.has("error") ? root.get("error").asText() : "Unknown error";
        if (sessionId != null && requestId != null) {
            localToolSessionRegistry.completeToolRequestError(sessionId, requestId, error);
        }
    }

    private void handleCancel(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        if (sessionId == null) return;
        AtomicBoolean flag = cancelFlags.get(sessionId);
        if (flag != null) {
            flag.set(true);
            registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "CANCELLING")));
            log.info("Cancel requested for session {} by userId={}", sessionId, userId);
        }
    }

    private Long getLong(JsonNode root, String field) {
        if (!root.has(field) || root.get(field).isNull()) return null;
        try {
            return root.get(field).asLong();
        } catch (Exception e) {
            return null;
        }
    }

    private Long resolveUserId(WebSocketSession session) {
        // Extract token from query string: /ws/stream?token=xxx
        String query = session.getUri() != null ? session.getUri().getQuery() : null;
        if (query == null) return null;
        for (String param : query.split("&")) {
            String[] kv = param.split("=", 2);
            if (kv.length == 2 && "token".equals(kv[0])) {
                return parseUserIdFromToken(kv[1]);
            }
        }
        return null;
    }

    private boolean syncSkillsToClient(Long userId, Long sessionId, Session session, Agent agent) {
        String syncUrl = "/v1/skills/sync-package?sessionId=" + sessionId;
        List<String> removed = skillSyncService.getRemovedSkillNames(session.getAgentId(), session.getWorkspace());
        log.info("Syncing skills to client for session={}, userId={}, syncUrl={}, workspace={}, removed={}", sessionId, userId, syncUrl, session.getWorkspace(), removed);

        CompletableFuture<Void> syncFuture = new CompletableFuture<>();
        pendingSkillSyncs.put(sessionId, syncFuture);
        registry.send(userId, WsEvent.of("skill_sync_required", sessionId,
                Map.of("syncUrl", syncUrl, "removed", removed, "workspace", session.getWorkspace() != null ? session.getWorkspace() : "")));
        log.info("Sent skill_sync_required to userId={}, sessionId={}", userId, sessionId);

        try {
            syncFuture.get(60, TimeUnit.SECONDS);
            return true;
        } catch (Exception e) {
            log.warn("Skill sync timeout for session {}", sessionId);
            return false;
        } finally {
            pendingSkillSyncs.remove(sessionId);
        }
    }

    private void handleSkillSyncDone(Long userId, JsonNode root) {
        Long sessionId = getLong(root, "sessionId");
        log.info("Received skill_sync_done from userId={}, sessionId={}", userId, sessionId);
        if (sessionId == null) return;
        CompletableFuture<Void> future = pendingSkillSyncs.get(sessionId);
        if (future != null) {
            future.complete(null);
            log.info("Skill sync confirmed for session {}", sessionId);
        } else {
            log.warn("No pending skill sync future for session={}", sessionId);
        }
    }

    private Long parseUserIdFromToken(String token) {
        try {
            // Reuse the same JWT parsing logic as the auth filter
            String[] parts = token.split("\\.");
            if (parts.length < 2) return null;
            String payload = new String(java.util.Base64.getUrlDecoder().decode(parts[1]));
            JsonNode claims = objectMapper.readTree(payload);
            // "sub" claim contains the userId
            if (claims.has("sub")) {
                return Long.parseLong(claims.get("sub").asText());
            }
        } catch (Exception e) {
            log.debug("Failed to parse JWT token for WS: {}", e.getMessage());
        }
        return null;
    }
}
