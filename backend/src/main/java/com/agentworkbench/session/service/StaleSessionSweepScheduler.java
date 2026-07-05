package com.agentworkbench.session.service;

import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.ws.StreamingWsHandler;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Periodically finds stale RUNNING/RESUMING sessions and terminates them with client notification.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class StaleSessionSweepScheduler {

    private final SessionService sessionService;
    private final StreamingWsHandler streamingWsHandler;

    @Scheduled(fixedRate = 60_000)
    public void sweepStaleRunningSessions() {
        List<Session> stale = sessionService.findStaleRunningSessions();
        if (stale.isEmpty()) {
            return;
        }
        log.warn("Sweeping {} stale sessions to FAILED (no activity for {}min)",
                stale.size(), SessionService.getStaleMinutes());
        for (Session session : stale) {
            try {
                streamingWsHandler.terminateStaleSession(session.getId(), session.getUserId());
            } catch (Exception e) {
                log.error("Failed to terminate stale session {}", session.getId(), e);
            }
        }
    }
}
