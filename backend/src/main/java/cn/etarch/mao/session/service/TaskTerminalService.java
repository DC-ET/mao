package cn.etarch.mao.session.service;

import cn.etarch.mao.notification.task.entity.TaskNotificationDelivery;
import cn.etarch.mao.notification.task.service.TaskNotificationDeliveryService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executor;

@Slf4j
@Service
public class TaskTerminalService {
    private final SessionService sessionService;
    private final StreamingWsRegistry registry;
    private final TaskNotificationDeliveryService deliveryService;
    private final Executor notificationExecutor;

    public TaskTerminalService(SessionService sessionService,
                               StreamingWsRegistry registry,
                               TaskNotificationDeliveryService deliveryService,
                               @Qualifier("taskNotificationExecutor") Executor notificationExecutor) {
        this.sessionService = sessionService;
        this.registry = registry;
        this.deliveryService = deliveryService;
        this.notificationExecutor = notificationExecutor;
    }

    public void finishExecution(Long sessionId, Long userId, String phase, String executionId) {
        if (!("COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase))) {
            throw new IllegalArgumentException("Unsupported terminal phase: " + phase);
        }
        Session previous = sessionService.getSession(sessionId);
        // Once a session reaches a terminal phase it must not transition to another
        // terminal phase. This prevents a late cancel from overriding a COMPLETED/FAILED
        // session (and vice versa) when the request races the execution thread's finish.
        if (isTerminalPhase(previous.getPhase())) {
            log.info("Ignoring terminal transition for already-terminal session: sessionId={}, from={}, to={}",
                    sessionId, previous.getPhase(), phase);
            return;
        }
        sessionService.updatePhase(sessionId, phase);
        Session session = sessionService.getSession(sessionId);
        Long ownerId = userId != null ? userId : session.getUserId();

        Map<String, Object> statusData = new HashMap<>();
        statusData.put("phase", phase);
        statusData.put("unread", true);
        if (executionId != null && !executionId.isBlank()) statusData.put("executionId", executionId);

        Optional<TaskNotificationDelivery> delivery = prepareDelivery(session, phase, executionId);
        registry.send(ownerId, WsEvent.of("session_list_update", sessionId, Map.of("phase", phase)));
        registry.sendWithResult(ownerId, WsEvent.of("session_status", sessionId, statusData))
                .whenCompleteAsync((result, error) -> {
                    if (delivery.isEmpty()) return;
                    boolean delivered = error == null && result != null && result.delivered();
                    try {
                        deliveryService.resolveWebSocket(delivery.get(), delivered);
                    } catch (Exception e) {
                        log.warn("Failed to resolve WS result for task notification: deliveryId={}, error={}",
                                delivery.get().getId(), e.getMessage());
                    }
                }, notificationExecutor);
    }

    private boolean isTerminalPhase(String phase) {
        return "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase);
    }

    private Optional<TaskNotificationDelivery> prepareDelivery(Session session, String phase, String executionId) {
        try {
            return deliveryService.prepare(session, phase, executionId);
        } catch (Exception e) {
            log.warn("Failed to prepare task notification delivery: sessionId={}, error={}",
                    session.getId(), e.getMessage());
            return Optional.empty();
        }
    }
}
