package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Objects;

@Slf4j
@Service
@RequiredArgsConstructor
public class SubagentResultDeliveryService {

    private final SubagentExecutionMapper executionMapper;
    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final ObjectMapper objectMapper;
    private final SubagentRecoveryResultFactory resultFactory;

    @Transactional
    public boolean deliver(Long executionId) {
        SubagentExecution execution = executionMapper.selectByIdForUpdate(executionId);
        if (execution == null || isSettled(execution.getDeliveryStatus())) {
            return false;
        }
        if (sessionMapper.lockActiveSessionById(execution.getParentSessionId()) == null) {
            suppress(execution);
            return false;
        }
        Session parent = sessionMapper.selectById(execution.getParentSessionId());
        if (parent == null || isTerminal(parent.getPhase())) {
            suppressPending(execution.getParentSessionId());
            return false;
        }

        inferLegacyFields(execution);
        ExistingPair existing = findExistingPair(execution);
        if (existing != null) {
            markDelivered(execution, existing.assistantId(), existing.toolId());
            log.info("subagent_result_delivery_skipped executionId={} reason=messages_exist", executionId);
            return true;
        }
        removeBrokenAssociation(execution);

        String toolName = "FOLLOWUP".equals(execution.getInvocationType())
                ? "delegate_followup" : "delegate";
        Map<String, Object> arguments = "FOLLOWUP".equals(execution.getInvocationType())
                ? Map.of("child_session_id", execution.getChildSessionId(), "task", safe(execution.getTaskDescription()))
                : Map.of("agent_type", safe(execution.getAgentType()), "task", safe(execution.getTaskDescription()));
        ChatRequest.ToolCall toolCall = ChatRequest.ToolCall.builder()
                .id(execution.getParentToolCallId())
                .type("function")
                .function(ChatRequest.FunctionCall.builder()
                        .name(toolName)
                        .arguments(writeJson(arguments))
                        .build())
                .build();

        Message assistant = message(execution.getParentSessionId(), "ASSISTANT", "");
        assistant.setToolCalls(writeJson(List.of(toolCall)));
        messageMapper.insert(assistant);

        Message tool = message(execution.getParentSessionId(), "TOOL", resultFactory.create(execution));
        tool.setToolCallId(execution.getParentToolCallId());
        tool.setSourceSessionId(execution.getChildSessionId());
        messageMapper.insert(tool);

        markDelivered(execution, assistant.getId(), tool.getId());
        sessionMapper.updateById(parent);
        log.info("subagent_result_delivered executionId={} parent={} toolCallId={}",
                executionId, execution.getParentSessionId(), execution.getParentToolCallId());
        return true;
    }

    @Transactional
    public void suppressForTerminalParent(Long parentSessionId) {
        if (sessionMapper.lockActiveSessionById(parentSessionId) != null) {
            suppressPending(parentSessionId);
        }
    }

    private void inferLegacyFields(SubagentExecution execution) {
        if (execution.getInvocationType() == null) {
            SubagentExecution first = executionMapper.selectFirstByChildSessionId(execution.getChildSessionId());
            execution.setInvocationType(first != null && Objects.equals(first.getId(), execution.getId())
                    ? "DELEGATE" : "FOLLOWUP");
        }
        if (execution.getParentToolCallId() == null || execution.getParentToolCallId().isBlank()) {
            execution.setParentToolCallId("recovered_subagent_execution_" + execution.getId());
        }
        executionMapper.updateById(execution);
    }

    private ExistingPair findExistingPair(SubagentExecution execution) {
        List<Message> raw = rawMessages(execution.getParentSessionId());
        Long assistantId = null;
        Long toolId = null;
        for (Message message : raw) {
            if ("ASSISTANT".equals(message.getRole())
                    && containsToolCall(message.getToolCalls(), execution.getParentToolCallId())) {
                assistantId = message.getId();
            }
            if ("TOOL".equals(message.getRole())
                    && execution.getParentToolCallId().equals(message.getToolCallId())) {
                toolId = message.getId();
            }
        }
        return assistantId != null && toolId != null ? new ExistingPair(assistantId, toolId) : null;
    }

    private void removeBrokenAssociation(SubagentExecution execution) {
        for (Message message : rawMessages(execution.getParentSessionId())) {
            boolean associatedTool = "TOOL".equals(message.getRole())
                    && execution.getParentToolCallId().equals(message.getToolCallId());
            boolean associatedAssistant = "ASSISTANT".equals(message.getRole())
                    && containsToolCall(message.getToolCalls(), execution.getParentToolCallId());
            if (associatedTool || associatedAssistant) {
                messageMapper.deleteById(message.getId());
            }
        }
    }

    private List<Message> rawMessages(Long sessionId) {
        return messageMapper.selectList(new LambdaQueryWrapper<Message>()
                .eq(Message::getSessionId, sessionId)
                .orderByAsc(Message::getId));
    }

    private boolean containsToolCall(String json, String toolCallId) {
        if (json == null || json.isBlank()) return false;
        try {
            List<ChatRequest.ToolCall> calls = objectMapper.readValue(json, new TypeReference<>() {});
            return calls.stream().anyMatch(call -> toolCallId.equals(call.getId()));
        } catch (Exception e) {
            return false;
        }
    }

    private void suppressPending(Long parentSessionId) {
        List<SubagentExecution> pending = executionMapper.selectList(
                new LambdaQueryWrapper<SubagentExecution>()
                        .eq(SubagentExecution::getParentSessionId, parentSessionId)
                        .eq(SubagentExecution::getDeliveryStatus, "PENDING"));
        for (SubagentExecution item : pending) suppress(item);
    }

    private void suppress(SubagentExecution execution) {
        execution.setDeliveryStatus("SUPPRESSED");
        execution.setParentResultDeliveredAt(LocalDateTime.now());
        executionMapper.updateById(execution);
    }

    private void markDelivered(SubagentExecution execution, Long assistantId, Long toolId) {
        execution.setDeliveryStatus("DELIVERED");
        execution.setParentAssistantMessageId(assistantId);
        execution.setParentToolMessageId(toolId);
        execution.setParentResultDeliveredAt(LocalDateTime.now());
        executionMapper.updateById(execution);
    }

    private Message message(Long sessionId, String role, String content) {
        Message message = new Message();
        message.setSessionId(sessionId);
        message.setRole(role);
        message.setContent(content);
        message.setTokenCount(0);
        return message;
    }

    private boolean isSettled(String status) {
        return "DELIVERED".equals(status) || "SUPPRESSED".equals(status) || "LEGACY".equals(status);
    }

    private boolean isTerminal(String phase) {
        return "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase);
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to serialize subagent delivery payload", e);
        }
    }

    private String safe(String value) {
        return value != null ? value : "";
    }

    private record ExistingPair(Long assistantId, Long toolId) {}
}
