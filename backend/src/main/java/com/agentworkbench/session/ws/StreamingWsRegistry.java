package com.agentworkbench.session.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class StreamingWsRegistry {

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** userId → set of active WebSocket sessions (multi-device) */
    private final ConcurrentHashMap<Long, Set<WebSocketSession>> userSessions = new ConcurrentHashMap<>();

    /** WebSocket session → userId (reverse lookup) */
    private final ConcurrentHashMap<String, Long> sessionToUser = new ConcurrentHashMap<>();

    /** userId → set of subscribed sessionIds */
    private final ConcurrentHashMap<Long, Set<Long>> userSubscriptions = new ConcurrentHashMap<>();

    public void register(WebSocketSession session, Long userId) {
        String sessionId = session.getId();
        sessionToUser.put(sessionId, userId);
        userSessions.computeIfAbsent(userId, k -> ConcurrentHashMap.newKeySet()).add(session);
        log.info("WS stream registered: userId={}, wsSessionId={}", userId, sessionId);
    }

    public void unregister(WebSocketSession session) {
        String sessionId = session.getId();
        Long userId = sessionToUser.remove(sessionId);
        if (userId != null) {
            Set<WebSocketSession> sessions = userSessions.get(userId);
            if (sessions != null) {
                sessions.remove(session);
                if (sessions.isEmpty()) {
                    userSessions.remove(userId);
                    userSubscriptions.remove(userId);
                }
            }
            log.info("WS stream unregistered: userId={}, wsSessionId={}", userId, sessionId);
        }
    }

    public void subscribe(Long userId, Long sessionId) {
        userSubscriptions.computeIfAbsent(userId, k -> ConcurrentHashMap.newKeySet()).add(sessionId);
    }

    public void unsubscribe(Long userId, Long sessionId) {
        Set<Long> subs = userSubscriptions.get(userId);
        if (subs != null) {
            subs.remove(sessionId);
        }
    }

    public boolean isSubscribed(Long userId, Long sessionId) {
        Set<Long> subs = userSubscriptions.get(userId);
        return subs != null && subs.contains(sessionId);
    }

    /**
     * Send an event to all connections of a specific user.
     */
    public void send(Long userId, WsEvent event) {
        Set<WebSocketSession> sessions = userSessions.get(userId);
        if (sessions == null || sessions.isEmpty()) return;

        String json;
        try {
            json = objectMapper.writeValueAsString(event);
        } catch (Exception e) {
            log.error("Failed to serialize WsEvent", e);
            return;
        }

        TextMessage message = new TextMessage(json);
        for (WebSocketSession session : sessions) {
            if (session.isOpen()) {
                try {
                    synchronized (session) {
                        session.sendMessage(message);
                    }
                } catch (IOException e) {
                    log.warn("Failed to send WS message to userId={}, wsSessionId={}: {}",
                            userId, session.getId(), e.getMessage());
                }
            }
        }
    }

    /**
     * Send a raw JSON message to all connections of a specific user.
     */
    public void sendRaw(Long userId, String json) {
        Set<WebSocketSession> sessions = userSessions.get(userId);
        if (sessions == null || sessions.isEmpty()) return;

        TextMessage message = new TextMessage(json);
        for (WebSocketSession session : sessions) {
            if (session.isOpen()) {
                try {
                    synchronized (session) {
                        session.sendMessage(message);
                    }
                } catch (IOException e) {
                    log.warn("Failed to send raw WS message to userId={}: {}", userId, e.getMessage());
                }
            }
        }
    }

    public boolean hasConnection(Long userId) {
        Set<WebSocketSession> sessions = userSessions.get(userId);
        return sessions != null && sessions.stream().anyMatch(WebSocketSession::isOpen);
    }

    /**
     * Get all subscribed session IDs for a user.
     */
    public Set<Long> getSubscribedSessionIds(Long userId) {
        Set<Long> subs = userSubscriptions.get(userId);
        return subs != null ? Set.copyOf(subs) : Set.of();
    }

    public Long getUserId(WebSocketSession session) {
        return sessionToUser.get(session.getId());
    }
}
