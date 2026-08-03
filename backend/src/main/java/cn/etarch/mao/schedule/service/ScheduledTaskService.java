package cn.etarch.mao.schedule.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.core.AgentEventListener;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.mapper.ScheduledTaskMapper;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.MessageQueueService;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.TaskTerminalService;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.service.ContextTokenRepository;
import cn.etarch.mao.weixin.service.WeixinAccountRepository;
import cn.etarch.mao.weixin.service.WeixinSendService;
import cn.etarch.mao.weixin.service.WeixinSessionService;
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

@Slf4j
@Service
public class ScheduledTaskService {

    private final ScheduledTaskMapper scheduledTaskMapper;
    private final SessionService sessionService;
    private final MessageQueueService messageQueueService;
    private final HarnessService harnessService;
    private final TaskTerminalService taskTerminalService;
    private final WeixinSendService weixinSendService;
    private final WeixinAccountRepository weixinAccountRepository;
    private final ContextTokenRepository weixinContextTokenRepository;
    private final ExecutorService agentExecutor;

    public ScheduledTaskService(ScheduledTaskMapper scheduledTaskMapper,
                                SessionService sessionService,
                                MessageQueueService messageQueueService,
                                @Lazy HarnessService harnessService,
                                TaskTerminalService taskTerminalService,
                                WeixinSendService weixinSendService,
                                WeixinAccountRepository weixinAccountRepository,
                                ContextTokenRepository weixinContextTokenRepository,
                                @Qualifier("agentExecutor") ExecutorService agentExecutor) {
        this.scheduledTaskMapper = scheduledTaskMapper;
        this.sessionService = sessionService;
        this.messageQueueService = messageQueueService;
        this.harnessService = harnessService;
        this.taskTerminalService = taskTerminalService;
        this.weixinSendService = weixinSendService;
        this.weixinAccountRepository = weixinAccountRepository;
        this.weixinContextTokenRepository = weixinContextTokenRepository;
        this.agentExecutor = agentExecutor;
    }

    public ScheduledTask createTask(Long userId, Long agentId, Long sessionId,
                                     String name, String prompt, String cronExpression) {
        // Validate cron expression
        try {
            CronExpression.parse(cronExpression);
        } catch (IllegalArgumentException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无效的 cron 表达式: " + e.getMessage());
        }

        ScheduledTask task = new ScheduledTask();
        task.setUserId(userId);
        task.setAgentId(agentId);
        task.setSessionId(sessionId);
        task.setName(name);
        task.setPrompt(prompt);
        task.setCronExpression(cronExpression);
        task.setStatus("ACTIVE");
        task.setFireCount(0);
        task.setNextFireTime(calculateNextFireTime(cronExpression));
        scheduledTaskMapper.insert(task);

        log.info("Created scheduled task: id={}, name={}, cron={}, sessionId={}",
                task.getId(), name, cronExpression, sessionId);
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
            LocalDateTime next = calculateNextFireTime(cronExpression);
            task.setNextFireTime(next);
            if (next != null) {
                // 新 cron 仍有触发计划 → 任务重新进入进行中
                task.setFinished(0);
                task.setFinishedAt(null);
            }
        }

        // Recalculate next_fire_time when activating a paused task
        if ("ACTIVE".equals(task.getStatus()) && task.getNextFireTime() == null) {
            LocalDateTime next = calculateNextFireTime(task.getCronExpression());
            task.setNextFireTime(next);
            if (next != null) {
                task.setFinished(0);
                task.setFinishedAt(null);
            }
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
        // Pre-update nextFireTime to prevent re-triggering while this execution is in-flight
        task.setNextFireTime(calculateNextFireTime(task.getCronExpression()));
        scheduledTaskMapper.updateById(task);

        String executionId = UUID.randomUUID().toString();
        Long userId = task.getUserId();

        // Submit to agent executor — all phase checks and state changes happen inside the lock
        agentExecutor.submit(() -> {
            synchronized (sessionLock(task.getSessionId())) {
                try {
                    Session session = sessionService.getSession(task.getSessionId());
                    if (session == null) {
                        log.error("Scheduled task {} references non-existent session {}",
                                task.getId(), task.getSessionId());
                        markTaskResult(task, "FAILED");
                        return;
                    }

                    // Check if session is busy
                    String phase = session.getPhase();
                    if ("RUNNING".equals(phase) || "RESUMING".equals(phase) || "WAITING_APPROVAL".equals(phase)) {
                        log.info("Session {} is busy ({}), enqueueing scheduled task {} to message queue",
                                task.getSessionId(), phase, task.getId());
                        messageQueueService.enqueue(task.getSessionId(), userId, task.getPrompt(), null);
                        markTaskResult(task, "QUEUED");
                        return;
                    }

                    // Set phase to RUNNING (gate), then persist USER message
                    sessionService.updatePhase(task.getSessionId(), "RUNNING");
                    try {
                        sessionService.saveMessage(task.getSessionId(), "USER", task.getPrompt(),
                                null, null, null, 0, null);
                    } catch (Exception e) {
                        sessionService.updatePhase(task.getSessionId(), "IDLE");
                        log.error("Failed to persist USER message for scheduled task {}, rolled back phase", task.getId(), e);
                        markTaskResult(task, "FAILED");
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

                    // Send result to WeChat channel if applicable
                    sendWeixinReplyIfApplicable(task.getSessionId(), userId);

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
                    // Update fireCount and lastFireTime after execution completes
                    task.setLastFireTime(LocalDateTime.now());
                    task.setFireCount(task.getFireCount() + 1);
                    // 任务确已执行到终态（排除 QUEUED：消息仍在队列中，尚未真正执行完）；
                    // 若 cron 已无下次匹配（一次性任务执行完毕），显式置为已完结
                    if (!"QUEUED".equals(task.getLastExecutionStatus())
                            && calculateNextFireTime(task.getCronExpression()) == null) {
                        task.setFinished(1);
                        task.setFinishedAt(LocalDateTime.now());
                    }
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

    /**
     * If the session belongs to a WeChat channel, send the latest assistant reply back to the user.
     */
    private void sendWeixinReplyIfApplicable(Long sessionId, Long userId) {
        try {
            Session session = sessionService.getSession(sessionId);
            if (session == null || !WeixinSessionService.PROJECT_KEY.equals(session.getProjectKey())) {
                return;
            }

            WeixinChannelAccount account = weixinAccountRepository.findByUserId(userId);
            if (account == null) {
                log.warn("Cannot send WeChat reply for scheduled task: no account found for userId={}", userId);
                return;
            }

            // Get the latest assistant message
            java.util.List<Message> messages = sessionService.getMessages(sessionId);
            String reply = null;
            for (int i = messages.size() - 1; i >= 0; i--) {
                if ("ASSISTANT".equals(messages.get(i).getRole())) {
                    reply = messages.get(i).getContent();
                    break;
                }
            }
            if (reply == null || reply.isBlank()) {
                log.warn("No assistant reply found for scheduled task WeChat delivery, sessionId={}", sessionId);
                return;
            }

            // Resolve wxUserId from context token table (sendText needs WeChat user ID, not system userId)
            String wxUserId = resolveWxUserId(account.getAccountId());
            if (wxUserId == null) {
                log.warn("Cannot send WeChat reply for scheduled task: no wxUserId found for accountId={}",
                        account.getAccountId());
                return;
            }

            boolean sent = weixinSendService.sendText(account.getAccountId(), wxUserId, reply);
            if (sent) {
                log.info("Scheduled task result sent to WeChat, sessionId={}, userId={}", sessionId, userId);
            } else {
                log.warn("Failed to send scheduled task result to WeChat, sessionId={}, userId={}", sessionId, userId);
            }
        } catch (Exception e) {
            log.error("Error sending WeChat reply for scheduled task, sessionId={}", sessionId, e);
        }
    }

    /**
     * Resolve the WeChat user ID from context tokens for the given account.
     * Returns the first wxUserId found (one account typically has one bound user).
     */
    private String resolveWxUserId(String accountId) {
        List<cn.etarch.mao.weixin.entity.WeixinChannelContextToken> tokens =
                weixinContextTokenRepository.findByAccountId(accountId);
        if (tokens != null && !tokens.isEmpty()) {
            return tokens.get(0).getWxUserId();
        }
        return null;
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
