package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.config.DelegateConfig;
import cn.etarch.mao.harness.core.AgentExecutionContext;
import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.harness.tool.impl.DelegateTool;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Service
@RequiredArgsConstructor
public class SubagentExecutionRecoveryService {

    private final SubagentExecutionMapper executionMapper;
    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final SessionService sessionService;
    private final SessionCompactionService compactionService;
    private final AgentDefinitionRegistry definitionRegistry;
    private final DelegateTool delegateTool;
    private final AgentLoop agentLoop;
    private final SubAgentVisibilityService visibilityService;
    private final LocalToolSessionRegistry localRegistry;
    private final DelegateConfig delegateConfig;
    private final ObjectMapper objectMapper;

    public void recover(Long executionId) {
        SubagentExecution execution = executionMapper.selectById(executionId);
        if (execution == null || isTerminal(execution.getStatus())) return;
        if (executionMapper.claimForRecovery(executionId) == 0) return;
        execution = executionMapper.selectById(executionId);
        Session parent = sessionMapper.selectById(execution.getParentSessionId());
        Session child = sessionMapper.selectById(execution.getChildSessionId());
        if (parent == null || child == null) {
            fail(execution, child, "子代理恢复失败：父会话或子会话不存在");
            return;
        }
        if (isTerminal(parent.getPhase())) {
            cancel(execution, child, "子代理已随父会话取消");
            return;
        }

        log.info("subagent_recovery_start executionId={} parent={} child={} invocation={}",
                executionId, parent.getId(), child.getId(), execution.getInvocationType());
        long started = System.currentTimeMillis();
        AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(child.getId());
        boolean local = "LOCAL".equalsIgnoreCase(child.getExecutionMode());
        try {
            Message existingFinal = findExistingFinal(execution);
            if (existingFinal != null) {
                completeFromExistingFinal(execution, child, existingFinal);
                return;
            }

            SessionCompaction compaction = compactionService.loadValidated(child.getId());
            sessionService.cleanupIncompleteTailAfterId(child.getId(), compactionService.boundaryOf(compaction));
            sessionService.updatePhase(child.getId(), "RESUMING");

            AgentDefinition definition = definitionRegistry.getDefinition(execution.getAgentType());
            if (definition == null) throw new IllegalStateException("未知的子代理类型: " + execution.getAgentType());
            AgentExecutionContext context = delegateTool.buildSubContext(child, definition);
            context.setCancelFlag(cancelFlag);

            long deadline = startedDeadline(execution.getStartedAt(), delegateConfig.getTimeoutSeconds());
            if (deadline <= System.currentTimeMillis()) {
                throw new IllegalStateException("子代理恢复失败：原委派执行已超时");
            }
            if (local) {
                localRegistry.setUserForSession(child.getId(), parent.getUserId());
                waitForLocal(child.getId(), deadline, cancelFlag);
            }

            long remainingSeconds = Math.max(1, (deadline - System.currentTimeMillis()) / 1000);
            SubAgentVisibilityService.VisibleRunResult run = visibilityService.executeVisibleWithTimeout(
                    child, context, false, cancelFlag, remainingSeconds, delegateConfig.getCancelGraceSeconds());
            SubAgentResultCollector collector = run.getCollector();
            if (cancelFlag.get()) {
                cancel(execution, child, "子代理已随父会话取消");
            } else if (collector.getError() != null) {
                fail(execution, child, "子代理恢复失败：" + collector.getError().getMessage());
            } else {
                String result = collector.getResult().isBlank() ? "(子代理未产生文本输出)" : collector.getResult();
                Message finalMessage = latestAssistantAfterStart(execution);
                if (finalMessage == null || collector.getResult().isBlank()) {
                    finalMessage = sessionService.saveMessage(child.getId(), "ASSISTANT", result,
                            collector.getThinkingContent(), null, null,
                            collector.getTotalUsage() != null ? collector.getTotalUsage().getTotalTokens() : 0,
                            context.getModelConfig() != null ? context.getModelConfig().getId() : null);
                }
                terminal(execution, "COMPLETED", result, context.getCurrentRound(), collector, finalMessage.getId());
                visibilityService.finishSubagent(child.getId(), parent.getUserId(), "COMPLETED", run.getExecutionId());
            }
        } catch (Exception e) {
            fail(execution, child, "子代理恢复失败：" + safeMessage(e));
        } finally {
            agentLoop.removeCancelFlag(child.getId());
            if (local) localRegistry.removeSession(child.getId());
            SubagentExecution done = executionMapper.selectById(executionId);
            log.info("subagent_recovery_complete executionId={} status={} durationMs={}", executionId,
                    done != null ? done.getStatus() : "UNKNOWN", System.currentTimeMillis() - started);
        }
    }

    private void waitForLocal(Long childId, long deadline, AtomicBoolean cancelFlag) throws InterruptedException {
        while (!localRegistry.isConnected(childId) && !cancelFlag.get() && System.currentTimeMillis() < deadline) {
            TimeUnit.MILLISECONDS.sleep(Math.min(250, Math.max(1, deadline - System.currentTimeMillis())));
        }
        if (cancelFlag.get()) {
            throw new IllegalStateException("LOCAL 客户端等待已取消");
        }
        if (!localRegistry.isConnected(childId)) {
            throw new IllegalStateException("子代理恢复失败：LOCAL 客户端未在恢复超时内连接");
        }
    }

    private long startedDeadline(LocalDateTime startedAt, int timeoutSeconds) {
        long started = startedAt != null
                ? startedAt.atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
                : System.currentTimeMillis();
        return started + timeoutSeconds * 1000L;
    }

    private Message findExistingFinal(SubagentExecution execution) {
        if (execution.getFinalMessageId() != null) {
            Message message = messageMapper.selectById(execution.getFinalMessageId());
            if (message != null && "ASSISTANT".equals(message.getRole())) return message;
        }
        return latestAssistantAfterStart(execution);
    }

    private Message latestAssistantAfterStart(SubagentExecution execution) {
        if (execution.getExecutionStartMessageId() == null) return null;
        return messageMapper.selectOne(new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, execution.getChildSessionId())
                .eq(Message::getRole, "ASSISTANT")
                .gt(Message::getId, execution.getExecutionStartMessageId())
                .isNull(Message::getToolCalls)
                .orderByDesc(Message::getId).last("LIMIT 1"));
    }

    private void completeFromExistingFinal(SubagentExecution execution, Session child, Message message) {
        String status = terminalStatus(message);
        terminal(execution, status, message.getContent(), execution.getTotalRounds(), null, message.getId());
        sessionService.updatePhase(child.getId(), status);
    }

    private String terminalStatus(Message message) {
        if (message.getMetadata() == null || message.getMetadata().isBlank()) return "COMPLETED";
        try {
            String status = objectMapper.readTree(message.getMetadata()).path("subagentTerminalStatus").asText();
            return "FAILED".equals(status) || "CANCELLED".equals(status) ? status : "COMPLETED";
        } catch (Exception ignored) {
            return "COMPLETED";
        }
    }

    private void fail(SubagentExecution execution, Session child, String result) {
        Message finalMessage = child != null ? sessionService.saveMessage(child.getId(), "ASSISTANT", result,
                null, null, null, 0, null,
                "{\"subagentTerminalStatus\":\"FAILED\"}") : null;
        terminal(execution, "FAILED", result, execution.getTotalRounds(), null,
                finalMessage != null ? finalMessage.getId() : null);
        if (child != null) visibilityService.finishSubagent(child.getId(), child.getUserId(), "FAILED", null);
    }

    private void cancel(SubagentExecution execution, Session child, String result) {
        terminal(execution, "CANCELLED", result, execution.getTotalRounds(), null, null);
        if (child != null) visibilityService.finishSubagent(child.getId(), child.getUserId(), "CANCELLED", null);
    }

    private void terminal(SubagentExecution execution, String status, String result, Integer rounds,
                          SubAgentResultCollector collector, Long finalMessageId) {
        execution.setStatus(status);
        execution.setResult(truncate(result));
        execution.setCompletedAt(LocalDateTime.now());
        execution.setFinalMessageId(finalMessageId);
        if (rounds != null) execution.setTotalRounds(rounds);
        if (collector != null) {
            execution.setTotalToolCalls(collector.getToolCallCount());
            if (collector.getTotalUsage() != null) {
                execution.setTotalPromptTokens(collector.getTotalUsage().getPromptTokens());
                execution.setTotalCompletionTokens(collector.getTotalUsage().getCompletionTokens());
            }
        }
        executionMapper.updateById(execution);
    }

    private boolean isTerminal(String status) {
        return "COMPLETED".equals(status) || "FAILED".equals(status) || "CANCELLED".equals(status);
    }

    private String truncate(String value) {
        return value != null && value.length() > 65000 ? value.substring(0, 65000) : value;
    }

    private String safeMessage(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }
}
