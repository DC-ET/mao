package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.core.AgentEventListener;
import cn.etarch.mao.harness.core.AgentExecutionContext;
import cn.etarch.mao.harness.core.CompositeAgentEventListener;
import cn.etarch.mao.harness.core.HarnessService;
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
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 子智能体可见性：创建通知、WS 流式、过程消息持久化。
 */
@Slf4j
@Service
public class SubAgentVisibilityService {

    private final StreamingWsRegistry registry;
    private final ActivityService activityService;
    private final SessionActivityHeartbeat activityHeartbeat;
    private final SessionTodoMapper sessionTodoMapper;
    private final SessionService sessionService;
    private final TaskTerminalService taskTerminalService;
    private final LlmModelMapper llmModelMapper;
    private final HarnessService harnessService;

    public SubAgentVisibilityService(StreamingWsRegistry registry,
                                     ActivityService activityService,
                                     SessionActivityHeartbeat activityHeartbeat,
                                     SessionTodoMapper sessionTodoMapper,
                                     SessionService sessionService,
                                     TaskTerminalService taskTerminalService,
                                     LlmModelMapper llmModelMapper,
                                     @Lazy HarnessService harnessService) {
        this.registry = registry;
        this.activityService = activityService;
        this.activityHeartbeat = activityHeartbeat;
        this.sessionTodoMapper = sessionTodoMapper;
        this.sessionService = sessionService;
        this.taskTerminalService = taskTerminalService;
        this.llmModelMapper = llmModelMapper;
        this.harnessService = harnessService;
    }

    /**
     * 通知桌面端子会话已创建，并 auto-subscribe，便于立即接收流式事件。
     *
     * @param toolCallId 触发本次委派的父会话 tool_call_id（可为 null）
     */
    public void notifySubagentCreated(Session parentSession, Session childSession,
                                      String agentType, String task, String toolCallId) {
        Long userId = parentSession.getUserId();
        Long parentSessionId = parentSession.getId();
        Long childSessionId = childSession.getId();

        registry.subscribe(userId, childSessionId);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("childSessionId", childSessionId);
        data.put("title", childSession.getTitle() != null ? childSession.getTitle() : "子代理");
        data.put("agentType", agentType != null ? agentType : "");
        data.put("task", task != null ? task : "");
        if (toolCallId != null && !toolCallId.isBlank()) {
            data.put("toolCallId", toolCallId);
        }
        registry.send(userId, WsEvent.of("subagent_session_created", parentSessionId, data));
        log.info("Notified subagent_session_created parent={} child={} agentType={} toolCallId={}",
                parentSessionId, childSessionId, agentType, toolCallId);
    }

    /**
     * 以可见方式执行子智能体：推送 RUNNING、组合 WS+结果收集、持久化中间轮次。
     */
    public VisibleRunResult executeVisible(Session childSession,
                                           AgentExecutionContext subContext,
                                           boolean skipExecute) {
        Long userId = childSession.getUserId();
        Long childSessionId = childSession.getId();
        String executionId = UUID.randomUUID().toString();
        SubAgentResultCollector resultCollector = new SubAgentResultCollector();

        if (skipExecute) {
            return new VisibleRunResult(resultCollector, executionId);
        }

        sessionService.updatePhase(childSessionId, "RUNNING");
        registry.send(userId, WsEvent.of("session_status", childSessionId,
                Map.of("phase", "RUNNING", "executionId", executionId)));

        boolean supportsVision = resolveSupportsVision(childSession);
        WsStreamingEventListener wsListener = new WsStreamingEventListener(
                registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                childSessionId, userId, executionId, supportsVision);

        AgentEventListener composite = new CompositeAgentEventListener(wsListener, resultCollector);
        try {
            harnessService.executePrepared(subContext, composite);
        } catch (Exception e) {
            log.error("Visible sub-agent execution failed for session {}", childSessionId, e);
            if (resultCollector.getError() == null) {
                resultCollector.onError(e);
            }
        }

        return new VisibleRunResult(resultCollector, executionId);
    }

    /**
     * 推送子会话终态（COMPLETED / FAILED / CANCELLED）。SUBAGENT 不会创建用户 Webhook。
     */
    public void finishSubagent(Long childSessionId, Long userId, String phase, String executionId) {
        try {
            taskTerminalService.finishExecution(childSessionId, userId, phase, executionId);
        } catch (Exception e) {
            log.warn("Failed to finish subagent session {}: {}", childSessionId, e.getMessage());
            try {
                sessionService.updatePhase(childSessionId, phase);
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("phase", phase);
                if (executionId != null) {
                    data.put("executionId", executionId);
                }
                registry.send(userId, WsEvent.of("session_status", childSessionId, data));
            } catch (Exception ignored) {
                // best-effort
            }
        }
    }

    private boolean resolveSupportsVision(Session session) {
        if (session.getModelId() == null) {
            return false;
        }
        try {
            LlmModel model = llmModelMapper.selectById(session.getModelId());
            return model != null && model.getSupportsVision() != null && model.getSupportsVision() == 1;
        } catch (Exception e) {
            return false;
        }
    }

    @Getter
    public static class VisibleRunResult {
        private final SubAgentResultCollector collector;
        private final String executionId;

        public VisibleRunResult(SubAgentResultCollector collector, String executionId) {
            this.collector = collector;
            this.executionId = executionId;
        }
    }
}
