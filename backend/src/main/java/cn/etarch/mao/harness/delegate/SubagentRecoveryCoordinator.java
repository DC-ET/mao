package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.core.SessionCrashRecoveryService;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class SubagentRecoveryCoordinator {

    private final SubagentExecutionMapper executionMapper;
    private final SessionMapper sessionMapper;
    private final SessionService sessionService;
    private final SessionCompactionService compactionService;
    private final SubagentExecutionRecoveryService recoveryService;
    private final SubagentResultDeliveryService deliveryService;
    private final SessionCrashRecoveryService sessionRecoveryService;
    @Qualifier("agentExecutor")
    private final ExecutorService agentExecutor;

    public void recoverAtStartup() {
        List<SubagentExecution> candidates = executionMapper.selectRecoveryCandidates();
        Map<Long, List<SubagentExecution>> byParent = candidates.stream()
                .collect(Collectors.groupingBy(SubagentExecution::getParentSessionId,
                        LinkedHashMap::new, Collectors.toList()));
        log.info("subagent_recovery_scan executions={} parents={}", candidates.size(), byParent.size());

        Set<Long> blockedParents = byParent.keySet();
        for (Map.Entry<Long, List<SubagentExecution>> entry : byParent.entrySet()) {
            agentExecutor.submit(() -> recoverParentGroup(entry.getKey(), entry.getValue()));
        }

        List<Session> stale = sessionMapper.selectList(new QueryWrapper<Session>()
                .in("phase", "RUNNING", "RESUMING")
                .ne("session_type", "SUBAGENT"));
        for (Session session : stale) {
            if (!blockedParents.contains(session.getId())) {
                agentExecutor.submit(() -> sessionRecoveryService.recover(session));
            }
        }
    }

    void recoverParentGroup(Long parentId, List<SubagentExecution> executions) {
        Session parent = sessionMapper.selectById(parentId);
        if (parent == null || isTerminal(parent.getPhase())) {
            deliveryService.suppressForTerminalParent(parentId);
            return;
        }
        List<Long> ids = executions.stream().map(SubagentExecution::getId).sorted().toList();
        log.info("parent_recovery_wait parent={} childExecutions={}", parentId, ids);
        List<CompletableFuture<Void>> futures = new ArrayList<>();
        for (SubagentExecution execution : executions) {
            if (isActive(execution.getStatus())) {
                futures.add(CompletableFuture.runAsync(() -> {
                    try {
                        recoveryService.recover(execution.getId());
                    } catch (Exception e) {
                        log.error("Subagent recovery escaped executionId={}", execution.getId(), e);
                    }
                }));
            }
        }
        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();

        parent = sessionMapper.selectById(parentId);
        if (parent == null || isTerminal(parent.getPhase())) {
            deliveryService.suppressForTerminalParent(parentId);
            return;
        }
        SessionCompaction compaction = compactionService.loadValidated(parentId);
        sessionService.cleanupIncompleteTailAfterId(parentId, compactionService.boundaryOf(compaction));
        executions.stream().sorted(Comparator.comparing(SubagentExecution::getId))
                .forEach(execution -> deliveryService.deliver(execution.getId()));

        parent = sessionMapper.selectById(parentId);
        if (parent != null && !isTerminal(parent.getPhase())) {
            log.info("parent_recovery_start parent={}", parentId);
            sessionRecoveryService.recover(parent);
        }
    }

    private boolean isActive(String status) {
        return "RUNNING".equals(status) || "RECOVERING".equals(status);
    }

    private boolean isTerminal(String phase) {
        return "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase);
    }
}
