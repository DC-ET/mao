package cn.etarch.mao.session.service;

import cn.etarch.mao.notification.task.entity.TaskNotificationDelivery;
import cn.etarch.mao.notification.task.service.TaskNotificationDeliveryService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.concurrent.CompletableFuture;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskTerminalServiceTest {
    private final SessionService sessionService = mock(SessionService.class);
    private final StreamingWsRegistry registry = mock(StreamingWsRegistry.class);
    private final TaskNotificationDeliveryService deliveryService = mock(TaskNotificationDeliveryService.class);
    private final TaskTerminalService service = new TaskTerminalService(
            sessionService, registry, deliveryService, Runnable::run);

    @Test
    void suppressesWebhookWhenWebSocketWriteSucceeds() {
        Session running = session("RUNNING");
        Session completed = session("COMPLETED");
        TaskNotificationDelivery delivery = new TaskNotificationDelivery();
        delivery.setId(9L);
        when(sessionService.getSession(10L)).thenReturn(running, completed);
        when(deliveryService.prepare(completed, "COMPLETED", "exec-1")).thenReturn(Optional.of(delivery));
        when(registry.sendWithResult(eq(7L), any(WsEvent.class))).thenReturn(
                CompletableFuture.completedFuture(new StreamingWsRegistry.WsDeliveryResult(1, 1, 0)));

        service.finishExecution(10L, 7L, "COMPLETED", "exec-1");

        verify(sessionService).updatePhase(10L, "COMPLETED");
        verify(deliveryService).resolveWebSocket(delivery, true);
    }

    @Test
    void activatesWebhookWhenNoWebSocketWriteSucceeds() {
        Session running = session("RUNNING");
        Session failed = session("FAILED");
        TaskNotificationDelivery delivery = new TaskNotificationDelivery();
        delivery.setId(11L);
        when(sessionService.getSession(10L)).thenReturn(running, failed);
        when(deliveryService.prepare(failed, "FAILED", "exec-2")).thenReturn(Optional.of(delivery));
        when(registry.sendWithResult(eq(7L), any(WsEvent.class))).thenReturn(
                CompletableFuture.completedFuture(new StreamingWsRegistry.WsDeliveryResult(0, 0, 0)));

        service.finishExecution(10L, 7L, "FAILED", "exec-2");

        verify(deliveryService).resolveWebSocket(delivery, false);
    }

    @Test
    void ignoresDuplicateTerminalTransition() {
        when(sessionService.getSession(10L)).thenReturn(session("COMPLETED"));

        service.finishExecution(10L, 7L, "COMPLETED", "exec-1");

        verify(sessionService, never()).updatePhase(any(), any());
        verify(registry, never()).sendWithResult(any(), any());
    }

    private Session session(String phase) {
        Session session = new Session();
        session.setId(10L);
        session.setUserId(7L);
        session.setTitle("任务标题");
        session.setSessionType("NORMAL");
        session.setPhase(phase);
        return session;
    }
}
