package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

@Service
@RequiredArgsConstructor
public class SubagentExecutionLifecycleService {

    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final SubagentExecutionMapper executionMapper;

    @Transactional
    public CreatedDelegate createDelegate(Session parent, String agentType, String task,
                                          String title, String parentToolCallId) {
        Session child = sessionService.createSession(
                parent.getUserId(), parent.getAgentId(), title, parent.getExecutionMode(),
                parent.getWorkspace(), parent.getPermissionLevel(), parent.getIsGit(),
                parent.getPlatform(), parent.getShellPath(), parent.getOsVersion(), parent.getModelId());
        child.setParentSessionId(parent.getId());
        child.setSessionType("SUBAGENT");
        child.setPhase(null);
        sessionMapper.updateById(child);

        SubagentExecution execution = newExecution(parent.getId(), child.getId(), agentType,
                "DELEGATE", parentToolCallId, task);
        executionMapper.insert(execution);
        Message start = sessionService.saveMessage(child.getId(), "USER", task,
                null, null, null, 0, null);
        execution.setExecutionStartMessageId(start.getId());
        executionMapper.updateById(execution);
        return new CreatedDelegate(child, execution);
    }

    @Transactional
    public SubagentExecution createFollowup(Long parentSessionId, Long childSessionId,
                                             String agentType, String task, String parentToolCallId) {
        int claimed = sessionMapper.update(null, new LambdaUpdateWrapper<Session>()
                .eq(Session::getId, childSessionId)
                .and(w -> w.ne(Session::getPhase, "RUNNING").or().isNull(Session::getPhase))
                .set(Session::getPhase, "RUNNING"));
        if (claimed == 0) return null;
        Message start = sessionService.saveMessage(childSessionId, "USER", task,
                null, null, null, 0, null);
        SubagentExecution execution = newExecution(parentSessionId, childSessionId, agentType,
                "FOLLOWUP", parentToolCallId, task);
        execution.setExecutionStartMessageId(start.getId());
        executionMapper.insert(execution);
        return execution;
    }

    @Transactional
    public void markTerminal(SubagentExecution execution, String status, String result,
                             Integer rounds, Integer promptTokens, Integer completionTokens,
                             Integer toolCalls) {
        execution.setStatus(status);
        execution.setResult(truncate(result));
        execution.setCompletedAt(LocalDateTime.now());
        execution.setTotalRounds(rounds);
        execution.setTotalPromptTokens(promptTokens);
        execution.setTotalCompletionTokens(completionTokens);
        execution.setTotalToolCalls(toolCalls != null ? toolCalls : 0);
        Message finalMessage = messageMapper.selectOne(new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, execution.getChildSessionId())
                .eq(Message::getRole, "ASSISTANT")
                .gt(execution.getExecutionStartMessageId() != null,
                        Message::getId, execution.getExecutionStartMessageId())
                .isNull(Message::getToolCalls)
                .orderByDesc(Message::getId).last("LIMIT 1"));
        if (finalMessage != null) execution.setFinalMessageId(finalMessage.getId());
        executionMapper.updateById(execution);
    }

    private SubagentExecution newExecution(Long parentId, Long childId, String agentType,
                                            String invocationType, String toolCallId, String task) {
        SubagentExecution execution = new SubagentExecution();
        execution.setParentSessionId(parentId);
        execution.setChildSessionId(childId);
        execution.setAgentType(agentType);
        execution.setInvocationType(invocationType);
        execution.setParentToolCallId(toolCallId);
        execution.setDeliveryStatus("PENDING");
        execution.setTaskDescription(task);
        execution.setStatus("RUNNING");
        execution.setStartedAt(LocalDateTime.now());
        return execution;
    }

    private String truncate(String value) {
        if (value == null) return null;
        return value.length() > 65000 ? value.substring(0, 65000) + "..." : value;
    }

    public record CreatedDelegate(Session childSession, SubagentExecution execution) {}
}
