package cn.etarch.mao.harness.approval;

import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ApprovalRegistryTest {

    @Mock private SessionService sessionService;
    @Mock private SessionMapper sessionMapper;
    @Mock private StreamingWsRegistry streamingWsRegistry;

    private Session session(long id) {
        Session s = new Session();
        s.setId(id);
        s.setUserId(7L);
        return s;
    }

    private ApprovalRegistry registry() {
        return new ApprovalRegistry(sessionService, sessionMapper, streamingWsRegistry);
    }

    @Test
    void firstRegistrationEntersWaitingApprovalAndPublishes() {
        when(sessionMapper.selectById(10L)).thenReturn(session(10L));
        when(sessionService.enterWaitingApproval(10L)).thenReturn(true);

        registry().register(10L, "r1");

        verify(sessionService).enterWaitingApproval(10L);
        // session_status + session_list_update 各一次
        verify(streamingWsRegistry, times(2)).send(eq(7L), any(WsEvent.class));
    }

    @Test
    void registrationDoesNotOverwriteTerminalPhase() {
        // 会话已终态（如用户取消后 CANCELLED）：enterWaitingApproval 条件更新失败
        when(sessionService.enterWaitingApproval(10L)).thenReturn(false);

        registry().register(10L, "r1");

        verify(sessionService).enterWaitingApproval(10L);
        // 未进入待审批 → 不发布 phase 事件
        verify(streamingWsRegistry, never()).send(eq(7L), any(WsEvent.class));
    }

    @Test
    void parallelApprovalsStayWaitingUntilAllResolved() {
        when(sessionMapper.selectById(10L)).thenReturn(session(10L));
        when(sessionService.enterWaitingApproval(10L)).thenReturn(true);
        ApprovalRegistry reg = registry();

        reg.register(10L, "r1");
        reg.register(10L, "r2");

        // 仅首个登记置 WAITING_APPROVAL（enterWaitingApproval 只调用一次）
        verify(sessionService).enterWaitingApproval(10L);
        assertThat(reg.countForSession(10L)).isEqualTo(2);

        // 第一个完成：计数仍为 1，不恢复 RUNNING
        reg.unregister(10L, "r1");
        verify(sessionService, never()).restoreRunningAfterApproval(10L);
        assertThat(reg.countForSession(10L)).isEqualTo(1);

        // 第二个完成：计数归零，才尝试恢复
        reg.unregister(10L, "r2");
        verify(sessionService).restoreRunningAfterApproval(10L);
        assertThat(reg.countForSession(10L)).isZero();
    }

    @Test
    void singleApprovalRestoresImmediatelyOnUnregister() {
        when(sessionMapper.selectById(10L)).thenReturn(session(10L));
        when(sessionService.enterWaitingApproval(10L)).thenReturn(true);
        ApprovalRegistry reg = registry();

        reg.register(10L, "r1");
        reg.unregister(10L, "r1");

        verify(sessionService).restoreRunningAfterApproval(10L);
    }

    @Test
    void unregisterUnknownRequestIsNoOp() {
        ApprovalRegistry reg = registry();
        reg.unregister(10L, "missing");
        verify(sessionService, never()).restoreRunningAfterApproval(10L);
        verify(sessionService, never()).updatePhase(any(), any());
        verify(sessionService, never()).enterWaitingApproval(any());
    }

    @Test
    void countForSessionIdsReturnsOnlyPositiveCounts() {
        ApprovalRegistry reg = registry();
        reg.register(10L, "r1");
        reg.register(10L, "r2");
        reg.register(11L, "r3");

        Map<Long, Integer> counts = reg.countForSessionIds(List.of(10L, 11L, 12L));

        assertThat(counts).containsEntry(10L, 2).containsEntry(11L, 1).doesNotContainKey(12L);
    }

    @Test
    void nullInputsAreIgnored() {
        ApprovalRegistry reg = registry();
        reg.register(null, "r1");
        reg.register(10L, null);
        reg.unregister(null, "r1");
        reg.unregister(10L, null);
        assertThat(reg.countForSession(null)).isZero();
        assertThat(reg.countForSessionIds(null)).isEmpty();
        verify(sessionService, never()).updatePhase(any(), any());
        verify(sessionService, never()).enterWaitingApproval(any());
        verify(sessionService, never()).restoreRunningAfterApproval(any());
    }
}
