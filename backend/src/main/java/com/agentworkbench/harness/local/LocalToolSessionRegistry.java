package com.agentworkbench.harness.local;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry mapping sessionId to WebSocket connections for local tool execution.
 * Each session can have at most one connected desktop client.
 */
@Slf4j
@Component
public class LocalToolSessionRegistry {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ConcurrentHashMap<Long, LocalToolConnection> connections = new ConcurrentHashMap<>();

    public void register(Long sessionId, Long userId, WebSocketSession wsSession) {
        LocalToolConnection conn = new LocalToolConnection(sessionId, userId, wsSession);
        connections.put(sessionId, conn);
        log.info("Registered local tool connection for session {} (user={})", sessionId, userId);
    }

    public void unregister(Long sessionId) {
        LocalToolConnection conn = connections.remove(sessionId);
        if (conn != null) {
            conn.failAllPending("WebSocket connection closed");
            log.info("Unregistered local tool connection for session {}", sessionId);
        }
    }

    public boolean isConnected(Long sessionId) {
        LocalToolConnection conn = connections.get(sessionId);
        return conn != null && conn.wsSession.isOpen();
    }

    /**
     * Send a tool execution request to the connected desktop client.
     * Returns a CompletableFuture that completes when the client responds.
     */
    public CompletableFuture<String> sendToolRequest(Long sessionId, String toolName, String arguments, String workspace) {
        LocalToolConnection conn = connections.get(sessionId);
        if (conn == null || !conn.wsSession.isOpen()) {
            CompletableFuture<String> f = new CompletableFuture<>();
            f.complete("{\"error\":\"Local client is not connected\"}");
            return f;
        }

        String requestId = UUID.randomUUID().toString();
        CompletableFuture<String> future = new CompletableFuture<>();
        conn.pendingRequests.put(requestId, future);

        // Use ObjectMapper for proper JSON serialization — manual string escaping
        // breaks when arguments contain backslashes, newlines, or other special chars
        try {
            String message = objectMapper.writeValueAsString(Map.of(
                    "type", "tool_execute",
                    "requestId", requestId,
                    "toolName", toolName,
                    "arguments", arguments != null ? arguments : "{}",
                    "sessionId", sessionId,
                    "workspace", workspace != null ? workspace : ""
            ));

            synchronized (conn.wsSession) {
                conn.wsSession.sendMessage(new org.springframework.web.socket.TextMessage(message));
            }
            log.debug("Sent tool request {} to session {}: tool={}", requestId, sessionId, toolName);
        } catch (IOException e) {
            conn.pendingRequests.remove(requestId);
            future.complete("{\"error\":\"Failed to send request to local client: " + e.getMessage() + "\"}");
        }

        return future;
    }

    /**
     * Complete a pending tool request with the result from the desktop client.
     */
    public void completeToolRequest(Long sessionId, String requestId, String result) {
        LocalToolConnection conn = connections.get(sessionId);
        if (conn != null) {
            CompletableFuture<String> future = conn.pendingRequests.remove(requestId);
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
        LocalToolConnection conn = connections.get(sessionId);
        if (conn != null) {
            CompletableFuture<String> future = conn.pendingRequests.remove(requestId);
            if (future != null) {
                future.complete("{\"error\":\"" + error.replace("\"", "'") + "\"}");
                log.debug("Completed tool request {} with error for session {}", requestId, sessionId);
            }
        }
    }

    static class LocalToolConnection {
        final Long sessionId;
        final Long userId;
        final WebSocketSession wsSession;
        final ConcurrentHashMap<String, CompletableFuture<String>> pendingRequests = new ConcurrentHashMap<>();

        LocalToolConnection(Long sessionId, Long userId, WebSocketSession wsSession) {
            this.sessionId = sessionId;
            this.userId = userId;
            this.wsSession = wsSession;
        }

        void failAllPending(String reason) {
            for (Map.Entry<String, CompletableFuture<String>> entry : pendingRequests.entrySet()) {
                entry.getValue().complete("{\"error\":\"" + reason + "\"}");
            }
            pendingRequests.clear();
        }
    }
}
