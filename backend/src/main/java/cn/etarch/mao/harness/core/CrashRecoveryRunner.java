package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.activity.SessionActivityHeartbeat;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import cn.etarch.mao.session.ws.WsStreamingEventListener;
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
    private final SessionActivityHeartbeat activityHeartbeat;
    private final SessionTodoMapper sessionTodoMapper;
    private final LlmModelMapper llmModelMapper;
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
                    registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                    sessionId, userId, executionId, resolveSupportsVision(session));

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
            activityHeartbeat.clear(sessionId);
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

    private boolean resolveSupportsVision(Session session) {
        LlmModel model = null;
        if (session.getModelId() != null) {
            model = llmModelMapper.selectById(session.getModelId());
        }
        if (model == null) {
            model = llmModelMapper.selectOne(
                    new QueryWrapper<LlmModel>().eq("is_default", 1).eq("status", 1));
        }
        return model != null && model.getSupportsVision() != null && model.getSupportsVision() == 1;
    }
}
