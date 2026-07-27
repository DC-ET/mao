package cn.etarch.mao.schedule.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.core.AgentEventListener;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.mapper.ScheduledTaskMapper;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.TaskTerminalService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

@Slf4j
@Service
public class ScheduledTaskService {

    private final ScheduledTaskMapper scheduledTaskMapper;
    private final SessionService sessionService;
    private final HarnessService harnessService;
    private final TaskTerminalService taskTerminalService;
    private final ExecutorService agentExecutor;

    public ScheduledTaskService(ScheduledTaskMapper scheduledTaskMapper,
                                SessionService sessionService,
                                @Lazy HarnessService harnessService,
                                TaskTerminalService taskTerminalService,
                                @Qualifier("agentExecutor") ExecutorService agentExecutor) {
        this.scheduledTaskMapper = scheduledTaskMapper;
        this.sessionService = sessionService;
        this.harnessService = harnessService;
        this.taskTerminalService = taskTerminalService;
        this.agentExecutor = agentExecutor;
    }

    public ScheduledTask createTask(Long userId, Long agentId, String name,
                                     String prompt, String cronExpression) {
        // Validate cron expression
        try {
            CronExpression.parse(cronExpression);
        } catch (IllegalArgumentException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无效的 cron 表达式: " + e.getMessage());
        }

        // Create a dedicated session for this task
        Session session = sessionService.createSession(userId, agentId, "[定时] " + name);

        ScheduledTask task = new ScheduledTask();
        task.setUserId(userId);
        task.setAgentId(agentId);
        task.setSessionId(session.getId());
        task.setName(name);
        task.setPrompt(prompt);
        task.setCronExpression(cronExpression);
        task.setStatus("ACTIVE");
        task.setFireCount(0);
        task.setNextFireTime(calculateNextFireTime(cronExpression));
        scheduledTaskMapper.insert(task);

        log.info("Created scheduled task: id={}, name={}, cron={}, sessionId={}",
                task.getId(), name, cronExpression, session.getId());
        return task;
    }

    public ScheduledTask updateTask(Long taskId, Long userId, String name,
                                     String prompt, String cronExpression, String status) {
        ScheduledTask task = getTaskOwnedByUser(taskId, userId);

        if (name != null) task.setName(name);
        if (prompt != null) task.setPrompt(prompt);
        if (status != null) {
            if (!"ACTIVE".equals(status) && !"PAUSED".equals(status)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "状态只能为 ACTIVE 或 PAUSED");
            }
            task.setStatus(status);
        }
        if (cronExpression != null) {
            try {
                CronExpression.parse(cronExpression);
            } catch (IllegalArgumentException e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "无效的 cron 表达式: " + e.getMessage());
            }
            task.setCronExpression(cronExpression);
            if ("ACTIVE".equals(task.getStatus())) {
                task.setNextFireTime(calculateNextFireTime(cronExpression));
            }
        }

        // Recalculate next_fire_time when activating a paused task
        if ("ACTIVE".equals(task.getStatus()) && task.getNextFireTime() == null) {
            task.setNextFireTime(calculateNextFireTime(task.getCronExpression()));
        }

        scheduledTaskMapper.updateById(task);
        return task;
    }

    public void deleteTask(Long taskId, Long userId) {
        ScheduledTask task = getTaskOwnedByUser(taskId, userId);
        scheduledTaskMapper.deleteById(taskId);
        log.info("Deleted scheduled task: id={}, name={}", task.getId(), task.getName());
    }

    public List<ScheduledTask> listByUser(Long userId) {
        return scheduledTaskMapper.selectList(
                new LambdaQueryWrapper<ScheduledTask>()
                        .eq(ScheduledTask::getUserId, userId)
                        .orderByDesc(ScheduledTask::getCreatedAt));
    }

    public Page<ScheduledTask> listAll(int pageNum, int pageSize) {
        return scheduledTaskMapper.selectPage(
                new Page<>(pageNum, pageSize),
                new LambdaQueryWrapper<ScheduledTask>()
                        .orderByDesc(ScheduledTask::getCreatedAt));
    }

    public ScheduledTask getById(Long taskId) {
        return scheduledTaskMapper.selectById(taskId);
    }

    /**
     * Execute a due scheduled task. Called by ScheduledTaskScheduler.
     */
    public void executeTask(ScheduledTask task) {
        Session session = sessionService.getSession(task.getSessionId());
        if (session == null) {
            log.error("Scheduled task {} references non-existent session {}", task.getId(), task.getSessionId());
            markTaskResult(task, "FAILED");
            return;
        }

        // Skip if session is busy
        String phase = session.getPhase();
        if ("RUNNING".equals(phase) || "RESUMING".equals(phase) || "WAITING_APPROVAL".equals(phase)) {
            log.info("Skipping scheduled task {}: session {} is busy (phase={})",
                    task.getId(), task.getSessionId(), phase);
            markTaskResult(task, "SKIPPED");
            return;
        }

        // Update session phase first (gate), then persist USER message
        sessionService.updatePhase(task.getSessionId(), "RUNNING");
        try {
            sessionService.saveMessage(task.getSessionId(), "USER", task.getPrompt(),
                    null, null, null, 0, null);
        } catch (Exception e) {
            // Rollback phase if message persistence fails
            sessionService.updatePhase(task.getSessionId(), "IDLE");
            log.error("Failed to persist USER message for scheduled task {}, rolled back phase", task.getId(), e);
            markTaskResult(task, "FAILED");
            return;
        }

        String executionId = UUID.randomUUID().toString();
        Long userId = task.getUserId();

        // Pre-update nextFireTime to prevent re-triggering while this execution is in-flight
        task.setNextFireTime(calculateNextFireTime(task.getCronExpression()));
        scheduledTaskMapper.updateById(task);

        // Submit to agent executor
        Future<?> future = agentExecutor.submit(() -> {
            synchronized (sessionLock(task.getSessionId())) {
                try {
                    // Double-check session phase inside lock to avoid race with user messages
                    Session freshSession = sessionService.getSession(task.getSessionId());
                    if (freshSession != null && !"RUNNING".equals(freshSession.getPhase())
                            && !"RESUMING".equals(freshSession.getPhase())
                            && !"WAITING_APPROVAL".equals(freshSession.getPhase())) {
                        // Phase is still idle-safe, proceed
                    } else {
                        log.info("Scheduled task {} aborted: session {} became busy before execution",
                                task.getId(), task.getSessionId());
                        markTaskResult(task, "SKIPPED");
                        return;
                    }

                    harnessService.executeFromEvent(task.getSessionId(), executionId, new AgentEventListener() {
                        @Override public void onContentDelta(String delta) {}
                        @Override public void onToolCallStart(ChatRequest.ToolCall toolCall) {}
                        @Override public void onToolCallResult(String toolCallId, String result) {}
                        @Override public void onMessageEnd(ChatUsage usage) {}
                        @Override public void onError(Throwable t) {
                            log.error("Scheduled task {} execution error", task.getId(), t);
                        }
                    });

                    // Success
                    taskTerminalService.finishExecution(task.getSessionId(), userId, "COMPLETED", executionId);
                    markTaskResult(task, "COMPLETED");

                } catch (Exception e) {
                    log.error("Scheduled task {} execution failed", task.getId(), e);
                    try {
                        taskTerminalService.finishExecution(task.getSessionId(), userId, "FAILED",
                                executionId, e.getMessage());
                    } catch (Exception ex) {
                        log.error("Failed to finish execution for scheduled task {}", task.getId(), ex);
                    }
                    markTaskResult(task, "FAILED");
                } finally {
                    // Update fireCount and lastFireTime after execution completes (success or failure)
                    task.setLastFireTime(LocalDateTime.now());
                    task.setFireCount(task.getFireCount() + 1);
                    scheduledTaskMapper.updateById(task);
                }
            }
        });
    }

    public LocalDateTime calculateNextFireTime(String cronExpression) {
        try {
            CronExpression cron = CronExpression.parse(cronExpression);
            return cron.next(LocalDateTime.now());
        } catch (IllegalArgumentException e) {
            log.error("Invalid cron expression: {}", cronExpression, e);
            return null;
        }
    }

    private void markTaskResult(ScheduledTask task, String status) {
        task.setLastExecutionStatus(status);
        scheduledTaskMapper.updateById(task);
    }

    private ScheduledTask getTaskOwnedByUser(Long taskId, Long userId) {
        ScheduledTask task = scheduledTaskMapper.selectById(taskId);
        if (task == null) {
            throw new BusinessException(ErrorCode.SCHEDULED_TASK_NOT_FOUND);
        }
        if (!task.getUserId().equals(userId)) {
            throw new BusinessException(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED);
        }
        return task;
    }

    // Reuse the same lock mechanism as StreamingWsHandler
    private static final java.util.concurrent.ConcurrentMap<Long, Object> sessionLocks =
            new java.util.concurrent.ConcurrentHashMap<>();

    private static Object sessionLock(Long sessionId) {
        return sessionLocks.computeIfAbsent(sessionId, k -> new Object());
    }
}
