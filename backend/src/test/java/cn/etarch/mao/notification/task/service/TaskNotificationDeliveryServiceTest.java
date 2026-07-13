package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.notification.task.entity.TaskNotificationDelivery;
import cn.etarch.mao.notification.task.entity.UserTaskNotificationPreference;
import cn.etarch.mao.notification.task.mapper.TaskNotificationDeliveryMapper;
import cn.etarch.mao.session.entity.MessageQueue;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.MessageQueueService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskNotificationDeliveryServiceTest {
    private final TaskNotificationDeliveryMapper mapper = mock(TaskNotificationDeliveryMapper.class);
    private final TaskNotificationPreferenceService preferenceService = mock(TaskNotificationPreferenceService.class);
    private final MessageQueueService queueService = mock(MessageQueueService.class);
    private final TaskNotificationMetrics metrics = mock(TaskNotificationMetrics.class);
    private final TaskNotificationDeliveryService service = new TaskNotificationDeliveryService(
            mapper, preferenceService, queueService, metrics);

    @Test
    void createsWaitingDeliveryForEnabledUserTask() {
        Session session = session("NORMAL");
        UserTaskNotificationPreference preference = new UserTaskNotificationPreference();
        preference.setChannel("FEISHU");
        preference.setWebhookCiphertext("encrypted");
        when(queueService.listPending(10L)).thenReturn(List.of());
        when(preferenceService.findEnabled(7L)).thenReturn(preference);

        assertTrue(service.prepare(session, "COMPLETED", "exec-1").isPresent());

        ArgumentCaptor<TaskNotificationDelivery> captor = ArgumentCaptor.forClass(TaskNotificationDelivery.class);
        verify(mapper).insert(captor.capture());
        assertEquals("10:exec-1:COMPLETED", captor.getValue().getEventKey());
        assertEquals("WAITING_WS", captor.getValue().getStatus());
    }

    @Test
    void excludesCancelledSubagentAndQueuedIntermediateRound() {
        Session normal = session("NORMAL");
        assertTrue(service.prepare(normal, "CANCELLED", "exec-1").isEmpty());

        Session subagent = session("SUBAGENT");
        assertTrue(service.prepare(subagent, "COMPLETED", "exec-2").isEmpty());

        when(queueService.listPending(10L)).thenReturn(List.of(new MessageQueue()));
        assertTrue(service.prepare(normal, "FAILED", "exec-3").isEmpty());
        verify(mapper, never()).insert(any());
    }

    private Session session(String type) {
        Session session = new Session();
        session.setId(10L);
        session.setUserId(7L);
        session.setTitle("任务标题");
        session.setSessionType(type);
        return session;
    }
}
