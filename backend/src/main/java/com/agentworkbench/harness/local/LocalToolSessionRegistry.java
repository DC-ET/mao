package com.agentworkbench.harness.local;

import com.agentworkbench.session.ws.StreamingWsRegistry;
import com.agentworkbench.session.ws.WsEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry mapping sessionId to userId for local tool execution via Streaming WS.
 * Tool requests are sent through StreamingWsRegistry instead of direct WebSocket.
 */
@Slf4j
@Component
public class LocalToolSessionRegistry {

    private final StreamingWsRegistry streamingWsRegistry;

    /** sessionId → userId */
    private final ConcurrentHashMap<Long, Long> sessionToUser = new ConcurrentHashMap<>();

    /** sessionId → requestId → CompletableFuture */
    private final ConcurrentHashMap<Long, ConcurrentHashMap<String, CompletableFuture<String>>> pendingRequests = new ConcurrentHashMap<>();

    public LocalToolSessionRegistry(StreamingWsRegistry streamingWsRegistry) {
        this.streamingWsRegistry = streamingWsRegistry;
    }

    /**
     * Register a sessionId → userId mapping. Idempotent for the same userId.
     * If a different userId tries to register an already-registered sessionId,
     * fail old pending requests and re-register.
     */
    public void setUserForSession(Long sessionId, Long userId) {
        Long existing = sessionToUser.get(sessionId);
        if (existing != null && existing.equals(userId)) {
            return; // already registered with same user
        }
        if (existing != null && !existing.equals(userId)) {
            log.warn("Session {} already registered to user {}, re-registering to user {}", sessionId, existing, userId);
            failAllPending(sessionId, "Session re-registered to different user");
        }
        sessionToUser.put(sessionId, userId);
        log.info("Registered local tool session {} for user {}", sessionId, userId);
    }

    /**
     * Remove a session mapping and fail all pending requests.
     */
    public void removeSession(Long sessionId) {
        sessionToUser.remove(sessionId);
        failAllPending(sessionId, "Session unregistered");
        log.info("Unregistered local tool session {}", sessionId);
    }

    /**
     * Fail all pending requests for all sessions belonging to the given user.
     * Called when the user's streaming WS disconnects.
     */
    public void failAllForUser(Long userId) {
        List<Long> sessionsToClean = new ArrayList<>();
        for (Map.Entry<Long, Long> entry : sessionToUser.entrySet()) {
            if (entry.getValue().equals(userId)) {
                sessionsToClean.add(entry.getKey());
            }
        }
        for (Long sessionId : sessionsToClean) {
            sessionToUser.remove(sessionId);
            failAllPending(sessionId, "User disconnected");
        }
        if (!sessionsToClean.isEmpty()) {
            log.info("Failed all pending requests for user {} ({} sessions)", userId, sessionsToClean.size());
        }
    }

    /**
     * Check if a session has a registered user with an active streaming WS connection.
     */
    public boolean isConnected(Long sessionId) {
        Long userId = sessionToUser.get(sessionId);
        return userId != null && streamingWsRegistry.hasConnection(userId);
    }

    /**
     * Get the userId associated with a session, or null if not registered.
     */
    public Long getUserIdForSession(Long sessionId) {
        return sessionToUser.get(sessionId);
    }

    /**
     * Send a tool execution request to the connected desktop client via Streaming WS.
     * Returns a CompletableFuture that completes when the client responds.
     */
    public CompletableFuture<String> sendToolRequest(Long sessionId, String toolName, String arguments, String workspace) {
        Long userId = sessionToUser.get(sessionId);
        if (userId == null || !streamingWsRegistry.hasConnection(userId)) {
            CompletableFuture<String> f = new CompletableFuture<>();
            f.complete("{\"error\":\"Local client is not connected\"}");
            return f;
        }

        String requestId = UUID.randomUUID().toString();
        CompletableFuture<String> future = new CompletableFuture<>();
        pendingRequests.computeIfAbsent(sessionId, k -> new ConcurrentHashMap<>()).put(requestId, future);

        streamingWsRegistry.send(userId, WsEvent.of("tool_execute", sessionId, Map.of(
                "requestId", requestId,
                "toolName", toolName,
                "arguments", arguments != null ? arguments : "{}",
                "workspace", workspace != null ? workspace : ""
        )));

        log.debug("Sent tool request {} to session {}: tool={}, workspace={}", requestId, sessionId, toolName, workspace);
        return future;
    }

    /**
     * Complete a pending tool request with the result from the desktop client.
     */
    public void completeToolRequest(Long sessionId, String requestId, String result) {
        ConcurrentHashMap<String, CompletableFuture<String>> sessionRequests = pendingRequests.get(sessionId);
        if (sessionRequests != null) {
            CompletableFuture<String> future = sessionRequests.remove(requestId);
            if (future != null) {
                future.complete(result);
                log.debug("Completed tool request {} for session {}", requestId, sessionId);
            }
        }
    }

    /**
     * Complete a pending tool request with an error.
     */
    public void completeToolRequestError(Long sessionId, String requestId, String error) {
        ConcurrentHashMap<String, CompletableFuture<String>> sessionRequests = pendingRequests.get(sessionId);
        if (sessionRequests != null) {
            CompletableFuture<String> future = sessionRequests.remove(requestId);
            if (future != null) {
                future.complete("{\"error\":\"" + error.replace("\"", "'") + "\"}");
                log.debug("Completed tool request {} with error for session {}", requestId, sessionId);
            }
        }
    }

    private void failAllPending(Long sessionId, String reason) {
        ConcurrentHashMap<String, CompletableFuture<String>> sessionRequests = pendingRequests.remove(sessionId);
        if (sessionRequests != null) {
            for (Map.Entry<String, CompletableFuture<String>> entry : sessionRequests.entrySet()) {
                entry.getValue().complete("{\"error\":\"" + reason + "\"}");
            }
            sessionRequests.clear();
        }
    }
}
