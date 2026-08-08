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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

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

    /**
     * 子代理执行线程池（守护线程）。子代理整体执行有超时兜底，
     * 卡死时父 Agent 在超时后返回失败，不再被同步等待拖住。
     */
    private final ExecutorService subagentExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "subagent-executor");
        t.setDaemon(true);
        return t;
    });

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
     * 确保用户对某会话的 WS 订阅有效（追问复用既有子会话时兜底，幂等）。
     */
    public void ensureSubscribed(Long userId, Long sessionId) {
        registry.subscribe(userId, sessionId);
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
     * 带整体超时执行子智能体（见 {@link #executeVisible}）。
     *
     * <p>子代理 LLM 请求卡死（如 SSL 写阻塞导致 OkHttp 超时机制失效）时，若不加限制，
     * 同步等待会无限拖住父 Agent。这里在独立线程执行子代理，到达 {@code timeoutSeconds}
     * 后置位取消标志请求其退出，再给 {@code cancelGraceSeconds} 宽限期等待其响应取消；
     * 宽限期后仍卡死则放弃等待并抛出异常（由调用方标记失败返回）。</p>
     *
     * @param cancelFlag 子代理取消标志；超时后置位以请求其尽快退出（可为 null）
     */
    public VisibleRunResult executeVisibleWithTimeout(Session childSession,
                                                      AgentExecutionContext subContext,
                                                      boolean skip,
                                                      AtomicBoolean cancelFlag,
                                                      long timeoutSeconds,
                                                      long cancelGraceSeconds) {
        CompletableFuture<VisibleRunResult> subFuture = CompletableFuture.supplyAsync(
                () -> executeVisible(childSession, subContext, skip), subagentExecutor);
        try {
            return subFuture.get(timeoutSeconds, TimeUnit.SECONDS);
        } catch (TimeoutException te) {
            if (cancelFlag != null) {
                cancelFlag.set(true);
            }
            log.warn("Sub-agent session {} exceeded timeout {}s, requesting cancel",
                    childSession.getId(), timeoutSeconds);
            try {
                return subFuture.get(cancelGraceSeconds, TimeUnit.SECONDS);
            } catch (TimeoutException te2) {
                subFuture.cancel(true);
                throw new RuntimeException("子代理执行超时(>=" + timeoutSeconds
                        + "s)，已请求取消但未在宽限期(" + cancelGraceSeconds + "s)内退出");
            } catch (ExecutionException ee2) {
                Throwable cause = ee2.getCause() != null ? ee2.getCause() : ee2;
                throw new RuntimeException("子代理执行超时后终止异常: " + cause.getMessage(), cause);
            } catch (InterruptedException ie2) {
                Thread.currentThread().interrupt();
                if (cancelFlag != null) {
                    cancelFlag.set(true);
                }
                throw new RuntimeException("委派执行被中断", ie2);
            }
        } catch (ExecutionException ee) {
            Throwable cause = ee.getCause() != null ? ee.getCause() : ee;
            throw new RuntimeException("子代理执行失败: " + cause.getMessage(), cause);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            if (cancelFlag != null) {
                cancelFlag.set(true);
            }
            throw new RuntimeException("委派执行被中断", ie);
        }
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
