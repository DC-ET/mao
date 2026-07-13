package cn.etarch.mao.notification.task.scheduler;

import cn.etarch.mao.config.TaskNotificationProperties;
import cn.etarch.mao.notification.task.entity.TaskNotificationDelivery;
import cn.etarch.mao.notification.task.mapper.TaskNotificationDeliveryMapper;
import cn.etarch.mao.notification.task.model.DeliveryStatus;
import cn.etarch.mao.notification.task.model.NotificationChannel;
import cn.etarch.mao.notification.task.sender.WebhookSender.WebhookSendResult;
import cn.etarch.mao.notification.task.service.WebhookSecretCipher;
import cn.etarch.mao.notification.task.service.WebhookSenderRegistry;
import cn.etarch.mao.notification.task.service.TaskNotificationMetrics;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Component
public class WebhookDeliveryScheduler {
    private static final DateTimeFormatter TIME_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private final TaskNotificationDeliveryMapper mapper;
    private final TaskNotificationProperties properties;
    private final WebhookSecretCipher cipher;
    private final WebhookSenderRegistry senderRegistry;
    private final Executor executor;
    private final TaskNotificationMetrics metrics;
    private final AtomicBoolean recoveryCompleted = new AtomicBoolean(false);

    public WebhookDeliveryScheduler(TaskNotificationDeliveryMapper mapper,
                                    TaskNotificationProperties properties,
                                    WebhookSecretCipher cipher,
                                    WebhookSenderRegistry senderRegistry,
                                    TaskNotificationMetrics metrics,
                                    @Qualifier("taskNotificationExecutor") Executor executor) {
        this.mapper = mapper;
        this.properties = properties;
        this.cipher = cipher;
        this.senderRegistry = senderRegistry;
        this.metrics = metrics;
        this.executor = executor;
    }

    void recoverInterruptedDeliveries() {
        mapper.update(null, new LambdaUpdateWrapper<TaskNotificationDelivery>()
                .eq(TaskNotificationDelivery::getStatus, DeliveryStatus.SENDING.name())
                .lt(TaskNotificationDelivery::getUpdatedAt, LocalDateTime.now().minusMinutes(5))
                .set(TaskNotificationDelivery::getStatus, DeliveryStatus.PENDING.name())
                .set(TaskNotificationDelivery::getNextRetryAt, LocalDateTime.now()));
    }

    @Scheduled(fixedDelayString = "${app.task-notification.worker-delay-ms:30000}")
    public void dispatchDueDeliveries() {
        if (recoveryCompleted.compareAndSet(false, true)) {
            recoverInterruptedDeliveries();
        }
        LocalDateTime now = LocalDateTime.now();
        List<TaskNotificationDelivery> due = mapper.selectList(
                new LambdaQueryWrapper<TaskNotificationDelivery>()
                        .and(q -> q.eq(TaskNotificationDelivery::getStatus, DeliveryStatus.PENDING.name())
                                .le(TaskNotificationDelivery::getNextRetryAt, now)
                                .or(nested -> nested.eq(TaskNotificationDelivery::getStatus, DeliveryStatus.WAITING_WS.name())
                                        .le(TaskNotificationDelivery::getNextRetryAt, now)))
                        .orderByAsc(TaskNotificationDelivery::getId)
                        .last("LIMIT " + Math.max(1, properties.getBatchSize())));
        for (TaskNotificationDelivery delivery : due) {
            String expectedStatus = delivery.getStatus();
            int claimed = mapper.update(null, new LambdaUpdateWrapper<TaskNotificationDelivery>()
                    .eq(TaskNotificationDelivery::getId, delivery.getId())
                    .eq(TaskNotificationDelivery::getStatus, expectedStatus)
                    .set(TaskNotificationDelivery::getStatus, DeliveryStatus.SENDING.name()));
            if (claimed == 1) executor.execute(() -> deliver(delivery));
        }
        metrics.pending(mapper.selectCount(new LambdaQueryWrapper<TaskNotificationDelivery>()
                .in(TaskNotificationDelivery::getStatus, DeliveryStatus.WAITING_WS.name(),
                        DeliveryStatus.PENDING.name(), DeliveryStatus.SENDING.name())));
    }

    @Scheduled(cron = "0 20 3 * * *")
    public void cleanupHistory() {
        LocalDateTime cutoff = LocalDateTime.now().minusDays(90);
        mapper.delete(new LambdaQueryWrapper<TaskNotificationDelivery>()
                .in(TaskNotificationDelivery::getStatus, DeliveryStatus.SUCCEEDED.name(),
                        DeliveryStatus.FAILED.name(), DeliveryStatus.SUPPRESSED_WS.name())
                .lt(TaskNotificationDelivery::getCreatedAt, cutoff));
    }

    private void deliver(TaskNotificationDelivery delivery) {
        int attempt = (delivery.getAttemptCount() == null ? 0 : delivery.getAttemptCount()) + 1;
        WebhookSendResult result;
        try {
            NotificationChannel channel = NotificationChannel.parse(delivery.getChannel());
            String url = cipher.decrypt(delivery.getWebhookCiphertext());
            result = senderRegistry.get(channel).send(url, buildContent(delivery));
        } catch (Exception e) {
            result = WebhookSendResult.failure(false, null, null, "通知配置不可用");
        }

        TaskNotificationDelivery update = new TaskNotificationDelivery();
        update.setId(delivery.getId());
        update.setAttemptCount(attempt);
        update.setLastHttpStatus(result.httpStatus());
        update.setLastProviderCode(truncate(result.providerCode(), 64));
        update.setLastError(truncate(result.error(), 1000));
        if (result.success()) {
            update.setStatus(DeliveryStatus.SUCCEEDED.name());
            update.setSentAt(LocalDateTime.now());
            update.setNextRetryAt(null);
            log.info("Task notification delivered: deliveryId={}, sessionId={}, channel={}, attempt={}",
                    delivery.getId(), delivery.getSessionId(), delivery.getChannel(), attempt);
            metrics.sent(delivery.getChannel(), "success");
        } else if (result.retryable() && attempt < properties.getMaxAttempts()) {
            update.setStatus(DeliveryStatus.PENDING.name());
            update.setNextRetryAt(LocalDateTime.now().plusMinutes(retryDelayMinutes(attempt)));
            log.warn("Task notification retry scheduled: deliveryId={}, sessionId={}, channel={}, attempt={}",
                    delivery.getId(), delivery.getSessionId(), delivery.getChannel(), attempt);
            metrics.sent(delivery.getChannel(), "retryable_failure");
            metrics.retried(delivery.getChannel());
        } else {
            update.setStatus(DeliveryStatus.FAILED.name());
            update.setNextRetryAt(null);
            log.warn("Task notification failed: deliveryId={}, sessionId={}, channel={}, attempt={}, error={}",
                    delivery.getId(), delivery.getSessionId(), delivery.getChannel(), attempt, update.getLastError());
            metrics.sent(delivery.getChannel(), "failed");
        }
        mapper.updateById(update);
    }

    private String buildContent(TaskNotificationDelivery delivery) {
        String result = "COMPLETED".equals(delivery.getTerminalPhase()) ? "已完成" : "执行失败";
        return "Mao Agent 任务通知\n任务：" + delivery.getTitleSnapshot()
                + "\n结果：" + result + "\n时间：" + LocalDateTime.now().format(TIME_FORMAT);
    }

    private long retryDelayMinutes(int attempt) {
        return switch (attempt) {
            case 1 -> 1;
            case 2 -> 5;
            default -> 15;
        };
    }

    private String truncate(String value, int maxLength) {
        if (value == null) return null;
        return value.length() <= maxLength ? value : value.substring(0, maxLength);
    }
}
