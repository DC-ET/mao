package cn.etarch.mao.session.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

@Slf4j
@Component
public class StreamingWsRegistry {

    private enum SendTarget {
        ALL,
        LOCAL_ONLY
    }

    private record OutboundItem(Long userId, WsEvent event, String rawJson, SendTarget target,
                                CompletableFuture<WsDeliveryResult> resultFuture) {}

    public record WsDeliveryResult(int targetCount, int successCount, int failureCount) {
        public boolean delivered() {
            return successCount > 0;
        }
    }

    private static OutboundItem eventItem(Long userId, WsEvent event, SendTarget target) {
        return new OutboundItem(userId, event, null, target, null);
    }

    private static OutboundItem rawItem(Long userId, String rawJson, SendTarget target) {
        return new OutboundItem(userId, null, rawJson, target, null);
    }

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final BlockingQueue<OutboundItem> outboundQueue;
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Thread senderThread;

    /** userId → set of active WebSocket sessions (multi-device) */
    private final ConcurrentHashMap<Long, Set<WebSocketSession>> userSessions = new ConcurrentHashMap<>();

    /** WebSocket session → userId (reverse lookup) */
    private final ConcurrentHashMap<String, Long> sessionToUser = new ConcurrentHashMap<>();

    /** WebSocket session → client type (electron/browser) */
    private final ConcurrentHashMap<String, String> sessionToClientType = new ConcurrentHashMap<>();

    /** userId → set of subscribed sessionIds */
    private final ConcurrentHashMap<Long, Set<Long>> userSubscriptions = new ConcurrentHashMap<>();

    public StreamingWsRegistry(
            @Value("${app.ws.outbound-queue-capacity:10000}") int outboundQueueCapacity) {
        this.outboundQueue = new LinkedBlockingQueue<>(outboundQueueCapacity);
        this.senderThread = new Thread(this::drainOutboundLoop, "ws-outbound");
        this.senderThread.setDaemon(true);
        this.senderThread.start();
    }

    @PreDestroy
    void shutdown() {
        running.set(false);
        senderThread.interrupt();
    }

    public int getOutboundQueueSize() {
        return outboundQueue.size();
    }

    public void register(WebSocketSession session, Long userId, String clientType) {
        String sessionId = session.getId();
        sessionToUser.put(sessionId, userId);
        sessionToClientType.put(sessionId, normalizeClientType(clientType));
        userSessions.computeIfAbsent(userId, k -> ConcurrentHashMap.newKeySet()).add(session);
        log.info("WS stream registered: userId={}, wsSessionId={}, clientType={}",
                userId, sessionId, sessionToClientType.get(sessionId));
    }

    public void unregister(WebSocketSession session) {
        String sessionId = session.getId();
        Long userId = sessionToUser.remove(sessionId);
        sessionToClientType.remove(sessionId);
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
     * Enqueue an event for async delivery — does not block the caller on network I/O.
     */
    public void send(Long userId, WsEvent event) {
        enqueue(userId, event, SendTarget.ALL);
    }

    public CompletableFuture<WsDeliveryResult> sendWithResult(Long userId, WsEvent event) {
        CompletableFuture<WsDeliveryResult> future = new CompletableFuture<>();
        if (userId == null || event == null) {
            future.complete(new WsDeliveryResult(0, 0, 0));
            return future;
        }
        if (!outboundQueue.offer(new OutboundItem(userId, event, null, SendTarget.ALL, future))) {
            log.warn("WS outbound queue full, dropping tracked event type={} for userId={}",
                    event.getType(), userId);
            future.complete(new WsDeliveryResult(0, 0, 0));
        }
        return future;
    }

    /**
     * Enqueue an event for Electron desktop connections only.
     */
    public void sendToLocalClients(Long userId, WsEvent event) {
        enqueue(userId, event, SendTarget.LOCAL_ONLY);
    }

    /**
     * Enqueue a raw JSON message for async delivery.
     */
    public void sendRaw(Long userId, String json) {
        enqueueRaw(userId, json, SendTarget.ALL);
    }

    private void enqueue(Long userId, WsEvent event, SendTarget target) {
        if (userId == null || event == null) {
            return;
        }
        if (!outboundQueue.offer(eventItem(userId, event, target))) {
            log.warn("WS outbound queue full (capacity reached), dropping event type={} for userId={}",
                    event.getType(), userId);
        }
    }

    private void enqueueRaw(Long userId, String json, SendTarget target) {
        if (userId == null || json == null) {
            return;
        }
        if (!outboundQueue.offer(rawItem(userId, json, target))) {
            log.warn("WS outbound queue full, dropping raw message for userId={}", userId);
        }
    }

    private void drainOutboundLoop() {
        while (running.get()) {
            try {
                OutboundItem item = outboundQueue.poll(1, TimeUnit.SECONDS);
                if (item != null) {
                    deliver(item);
                }
            } catch (InterruptedException e) {
                if (!running.get()) {
                    Thread.currentThread().interrupt();
                    break;
                }
            } catch (Exception e) {
                log.warn("WS outbound delivery error: {}", e.getMessage());
            }
        }
    }

    private void deliver(OutboundItem item) {
        Set<WebSocketSession> sessions = userSessions.get(item.userId());
        if (sessions == null || sessions.isEmpty()) {
            completeResult(item, 0, 0, 0);
            return;
        }

        Set<WebSocketSession> targets = switch (item.target()) {
            case ALL -> sessions;
            case LOCAL_ONLY -> sessions.stream()
                    .filter(session -> "electron".equals(sessionToClientType.get(session.getId())))
                    .collect(Collectors.toSet());
        };
        if (targets.isEmpty()) {
            completeResult(item, 0, 0, 0);
            return;
        }

        String json;
        if (item.rawJson() != null) {
            json = item.rawJson();
        } else {
            try {
                json = objectMapper.writeValueAsString(item.event());
            } catch (Exception e) {
                log.error("Failed to serialize WsEvent", e);
                completeResult(item, targets.size(), 0, targets.size());
                return;
            }
        }

        TextMessage message = new TextMessage(json);
        int targetCount = 0;
        int successCount = 0;
        int failureCount = 0;
        for (WebSocketSession session : targets) {
            if (session.isOpen()) {
                targetCount++;
                try {
                    synchronized (session) {
                        session.sendMessage(message);
                    }
                    successCount++;
                } catch (IOException e) {
                    failureCount++;
                    log.warn("Failed to send WS message to userId={}, wsSessionId={}: {}",
                            item.userId(), session.getId(), e.getMessage());
                }
            }
        }
        completeResult(item, targetCount, successCount, failureCount);
    }

    private void completeResult(OutboundItem item, int targets, int successes, int failures) {
        if (item.resultFuture() != null && !item.resultFuture().isDone()) {
            item.resultFuture().complete(new WsDeliveryResult(targets, successes, failures));
        }
    }

    public boolean hasConnection(Long userId) {
        Set<WebSocketSession> sessions = userSessions.get(userId);
        return sessions != null && sessions.stream().anyMatch(WebSocketSession::isOpen);
    }

    public boolean hasLocalClientConnection(Long userId) {
        Set<WebSocketSession> sessions = userSessions.get(userId);
        return sessions != null && sessions.stream()
                .anyMatch(session -> session.isOpen()
                        && "electron".equals(sessionToClientType.get(session.getId())));
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

    private String normalizeClientType(String clientType) {
        return "electron".equalsIgnoreCase(clientType) ? "electron" : "browser";
    }
}
