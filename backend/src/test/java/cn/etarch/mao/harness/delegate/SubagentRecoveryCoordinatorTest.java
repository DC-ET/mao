package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.core.SessionCrashRecoveryService;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SubagentRecoveryCoordinatorTest {

    @Test
    void recoversAllChildrenThenDeliversInExecutionOrderBeforeParent() {
        SubagentExecutionMapper mapper = mock(SubagentExecutionMapper.class);
        SessionMapper sessionMapper = mock(SessionMapper.class);
        SessionService sessionService = mock(SessionService.class);
        SessionCompactionService compactionService = mock(SessionCompactionService.class);
        SubagentExecutionRecoveryService recovery = mock(SubagentExecutionRecoveryService.class);
        SubagentResultDeliveryService delivery = mock(SubagentResultDeliveryService.class);
        SessionCrashRecoveryService parentRecovery = mock(SessionCrashRecoveryService.class);
        ExecutorService executor = Executors.newCachedThreadPool();
        SubagentRecoveryCoordinator coordinator = new SubagentRecoveryCoordinator(
                mapper, sessionMapper, sessionService, compactionService, recovery, delivery,
                parentRecovery, executor);
        Session parent = new Session();
        parent.setId(1L);
        parent.setPhase("RUNNING");
        when(sessionMapper.selectById(1L)).thenReturn(parent);
        when(compactionService.boundaryOf(null)).thenReturn(0L);
        SubagentExecution high = execution(8L);
        SubagentExecution low = execution(3L);

        coordinator.recoverParentGroup(1L, List.of(high, low));

        verify(recovery).recover(3L);
        verify(recovery).recover(8L);
        InOrder ordered = inOrder(delivery, parentRecovery);
        ordered.verify(delivery).deliver(3L);
        ordered.verify(delivery).deliver(8L);
        ordered.verify(parentRecovery).recover(parent);
        verify(sessionService).cleanupIncompleteTailAfterId(1L, 0L);
        executor.shutdownNow();
    }

    private SubagentExecution execution(Long id) {
        SubagentExecution execution = new SubagentExecution();
        execution.setId(id);
        execution.setParentSessionId(1L);
        execution.setStatus("RUNNING");
        return execution;
    }
}
