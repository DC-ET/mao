package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.activity.SessionActivityHeartbeat;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.TaskTerminalService;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import cn.etarch.mao.session.ws.WsStreamingEventListener;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Service
@RequiredArgsConstructor
public class SessionCrashRecoveryService {

    private final SessionService sessionService;
    private final TaskTerminalService taskTerminalService;
    private final HarnessService harnessService;
    private final AgentLoop agentLoop;
    private final StreamingWsRegistry registry;
    private final ActivityService activityService;
    private final SessionActivityHeartbeat activityHeartbeat;
    private final SessionTodoMapper sessionTodoMapper;
    private final LlmModelMapper llmModelMapper;

    public void recover(Session session) {
        Long sessionId = session.getId();
        Long userId = session.getUserId();
        String executionId = UUID.randomUUID().toString();
        try {
            int deleted = sessionService.cleanupIncompleteTail(sessionId);
            if (deleted > 0) log.info("Session {}: cleaned up {} incomplete tail messages", sessionId, deleted);
            sessionService.updatePhase(sessionId, "RESUMING");
            notifyClient(userId, sessionId, "RUNNING");
            AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);
            WsStreamingEventListener listener = new WsStreamingEventListener(
                    registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                    sessionId, userId, executionId, resolveSupportsVision(session));
            log.info("Session {}: starting recovery execution", sessionId);
            sessionService.updatePhase(sessionId, "RUNNING");
            notifyClient(userId, sessionId, "RUNNING");
            harnessService.execute(sessionId, null, listener, cancelFlag);
            taskTerminalService.finishExecution(sessionId, userId,
                    cancelFlag.get() ? "CANCELLED" : "COMPLETED", executionId);
        } catch (Exception e) {
            log.error("Recovery failed for session {}", sessionId, e);
            try {
                taskTerminalService.finishExecution(sessionId, userId, "FAILED", executionId,
                        e.getMessage() != null ? e.getMessage() : "Recovery failed");
            } catch (Exception ignored) {
            }
        } finally {
            agentLoop.removeCancelFlag(sessionId);
            activityHeartbeat.clear(sessionId);
        }
    }

    private void notifyClient(Long userId, Long sessionId, String phase) {
        if (userId == null) return;
        try {
            Map<String, Object> statusData = Map.of("phase", phase);
            registry.send(userId, WsEvent.of("session_status", sessionId, statusData));
            registry.send(userId, WsEvent.of("session_list_update", sessionId, statusData));
        } catch (Exception ignored) {
        }
    }

    private boolean resolveSupportsVision(Session session) {
        LlmModel model = session.getModelId() != null ? llmModelMapper.selectById(session.getModelId()) : null;
        if (model == null) {
            model = llmModelMapper.selectOne(new QueryWrapper<LlmModel>()
                    .eq("is_default", 1).eq("status", 1));
        }
        return model != null && Integer.valueOf(1).equals(model.getSupportsVision());
    }
}
