package com.agentworkbench.session.activity;

import com.agentworkbench.session.service.SessionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;

/**
 * Throttled heartbeat that refreshes session.last_activity_at during long-running agent work.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionActivityHeartbeat {

    private static final long MIN_INTERVAL_MS = 30_000;

    private final SessionService sessionService;
    private final ConcurrentHashMap<Long, Long> lastTouchMs = new ConcurrentHashMap<>();

    public void touch(Long sessionId) {
        if (sessionId == null) {
            return;
        }
        long now = System.currentTimeMillis();
        Long last = lastTouchMs.get(sessionId);
        if (last != null && now - last < MIN_INTERVAL_MS) {
            return;
        }
        lastTouchMs.put(sessionId, now);
        try {
            sessionService.touchLastActivity(sessionId);
        } catch (Exception e) {
            log.debug("Failed to touch last_activity_at for session {}: {}", sessionId, e.getMessage());
        }
    }

    public void clear(Long sessionId) {
        if (sessionId != null) {
            lastTouchMs.remove(sessionId);
        }
    }
}
