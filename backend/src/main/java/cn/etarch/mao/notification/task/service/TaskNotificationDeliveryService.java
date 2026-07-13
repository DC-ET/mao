package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.notification.task.entity.TaskNotificationDelivery;
import cn.etarch.mao.notification.task.entity.UserTaskNotificationPreference;
import cn.etarch.mao.notification.task.mapper.TaskNotificationDeliveryMapper;
import cn.etarch.mao.notification.task.model.DeliveryStatus;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.MessageQueueService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.Optional;

@Slf4j
@Service
@RequiredArgsConstructor
public class TaskNotificationDeliveryService {
    private final TaskNotificationDeliveryMapper mapper;
    private final TaskNotificationPreferenceService preferenceService;
    private final MessageQueueService messageQueueService;
    private final TaskNotificationMetrics metrics;

    public Optional<TaskNotificationDelivery> prepare(Session session, String phase, String executionId) {
        if (session == null || !("COMPLETED".equals(phase) || "FAILED".equals(phase))) return Optional.empty();
        if ("SUBAGENT".equals(session.getSessionType())) return Optional.empty();
        if (!messageQueueService.listPending(session.getId()).isEmpty()) return Optional.empty();
        UserTaskNotificationPreference preference = preferenceService.findEnabled(session.getUserId());
        if (preference == null) return Optional.empty();

        String resolvedExecutionId = executionId == null || executionId.isBlank()
                ? java.util.UUID.randomUUID().toString() : executionId;
        String eventKey = session.getId() + ":" + resolvedExecutionId + ":" + phase;
        TaskNotificationDelivery delivery = new TaskNotificationDelivery();
        delivery.setEventKey(eventKey);
        delivery.setUserId(session.getUserId());
        delivery.setSessionId(session.getId());
        delivery.setExecutionId(resolvedExecutionId);
        delivery.setTerminalPhase(phase);
        delivery.setChannel(preference.getChannel());
        delivery.setWebhookCiphertext(preference.getWebhookCiphertext());
        delivery.setTitleSnapshot(normalizeTitle(session.getTitle()));
        delivery.setStatus(DeliveryStatus.WAITING_WS.name());
        delivery.setAttemptCount(0);
        delivery.setNextRetryAt(LocalDateTime.now().plusSeconds(10));
        try {
            mapper.insert(delivery);
            metrics.created(delivery.getChannel(), phase);
            return Optional.of(delivery);
        } catch (DuplicateKeyException e) {
            log.info("Task notification delivery already exists: eventKey={}", eventKey);
            return Optional.empty();
        }
    }

    public void resolveWebSocket(TaskNotificationDelivery delivery, boolean delivered) {
        if (delivery == null || delivery.getId() == null) return;
        TaskNotificationDelivery update = new TaskNotificationDelivery();
        update.setId(delivery.getId());
        update.setStatus(delivered ? DeliveryStatus.SUPPRESSED_WS.name() : DeliveryStatus.PENDING.name());
        update.setNextRetryAt(delivered ? null : LocalDateTime.now());
        mapper.updateById(update);
        if (delivered) metrics.suppressedByWebSocket(delivery.getChannel());
    }

    private String normalizeTitle(String title) {
        String value = title == null || title.isBlank() ? "未命名任务" : title.trim();
        return value.length() <= 255 ? value : value.substring(0, 255);
    }
}
