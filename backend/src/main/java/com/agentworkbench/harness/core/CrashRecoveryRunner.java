package com.agentworkbench.harness.core;

import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.agentworkbench.session.activity.ActivityService;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.session.service.SessionService;
import com.agentworkbench.session.ws.StreamingWsRegistry;
import com.agentworkbench.session.ws.WsEvent;
import com.agentworkbench.session.ws.WsStreamingEventListener;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Spring Boot startup hook that detects sessions stuck in RUNNING phase
 * (from a prior crash) and submits them for automatic recovery.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class CrashRecoveryRunner implements ApplicationRunner {

    private final SessionMapper sessionMapper;
    private final SessionService sessionService;
    private final HarnessService harnessService;
    private final AgentLoop agentLoop;
    private final StreamingWsRegistry registry;
    private final ActivityService activityService;
    private final SessionTodoMapper sessionTodoMapper;
    @Qualifier("agentExecutor")
    private final ExecutorService agentExecutor;

    @Override
    public void run(ApplicationArguments args) {
        List<Session> stale = sessionMapper.selectList(
                new QueryWrapper<Session>().eq("phase", "RUNNING"));
        if (stale.isEmpty()) return;

        log.warn("Found {} sessions stuck in RUNNING after restart, initiating recovery", stale.size());

        for (Session session : stale) {
            agentExecutor.submit(() -> recoverSession(session));
        }
    }

    private void recoverSession(Session session) {
        Long sessionId = session.getId();
        Long userId = session.getUserId();
        try {
            // 1. Clean up incomplete tail messages (assistant+tool_calls without tool results)
            int deleted = sessionService.cleanupIncompleteTail(sessionId);
            if (deleted > 0) {
                log.info("Session {}: cleaned up {} incomplete tail messages", sessionId, deleted);
            }

            // 2. Mark as RESUMING
            sessionService.updatePhase(sessionId, "RESUMING");
            notifyClient(userId, sessionId, "RESUMING");

            // 3. Register cancel flag
            AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);

            // 4. Create listener — events are silently dropped if client is not connected
            String executionId = java.util.UUID.randomUUID().toString();
            WsStreamingEventListener listener = new WsStreamingEventListener(
                    registry, activityService, sessionTodoMapper, sessionService, sessionId, userId, executionId);

            // 5. Execute — HarnessService.execute() rebuilds context from DB
            log.info("Session {}: starting recovery execution", sessionId);
            sessionService.updatePhase(sessionId, "RUNNING");
            notifyClient(userId, sessionId, "RUNNING");
            harnessService.execute(sessionId, null, listener, cancelFlag);

            // 6. Normal completion
            if (cancelFlag.get()) {
                sessionService.updatePhase(sessionId, "CANCELLED");
                notifyClient(userId, sessionId, "CANCELLED");
            } else {
                sessionService.updatePhase(sessionId, "COMPLETED");
                notifyClient(userId, sessionId, "COMPLETED");
            }
            log.info("Session {}: recovery completed", sessionId);
        } catch (Exception e) {
            log.error("Recovery failed for session {}", sessionId, e);
            try {
                sessionService.updatePhase(sessionId, "FAILED");
            } catch (Exception ignored) {}
            notifyClient(userId, sessionId, "FAILED");
        } finally {
            agentLoop.removeCancelFlag(sessionId);
        }
    }

    private void notifyClient(Long userId, Long sessionId, String phase) {
        if (userId == null) return;
        try {
            boolean isTerminal = "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase);
            Map<String, Object> statusData = isTerminal
                    ? Map.of("phase", phase, "unread", true)
                    : Map.of("phase", phase);
            registry.send(userId, WsEvent.of("session_status", sessionId, statusData));
            registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", phase)));
        } catch (Exception ignored) {
            // Client may not be connected yet — that's fine
        }
    }
}
