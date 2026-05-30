package com.agentworkbench.session;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks active SSE emitters by session ID so phase changes can be
 * broadcast to all connected clients (not just the streaming session).
 */
@Slf4j
@Component
public class SseEmitterRegistry {

    private final ConcurrentHashMap<Long, SseEmitter> emitters = new ConcurrentHashMap<>();

    public void register(Long sessionId, SseEmitter emitter) {
        emitters.put(sessionId, emitter);
    }

    public void unregister(Long sessionId) {
        emitters.remove(sessionId);
    }

    /**
     * Broadcast a session_status event to ALL connected SSE clients.
     * Each client can decide whether to act on it based on sessionId.
     */
    public void broadcastPhaseChange(Long sessionId, String phase) {
        SseEmitter event = emitters.get(sessionId);
        if (event == null) return;
        try {
            event.send(SseEmitter.event()
                    .name("session_list_update")
                    .data(Map.of("sessionId", sessionId, "phase", phase)));
        } catch (Exception e) {
            log.warn("Failed to broadcast phase change for session {}: {}", sessionId, e.getMessage());
            emitters.remove(sessionId);
        }
    }
}
