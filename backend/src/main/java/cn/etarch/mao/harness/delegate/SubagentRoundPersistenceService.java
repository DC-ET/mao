package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class SubagentRoundPersistenceService {

    private final MessageMapper messageMapper;
    private final SessionMapper sessionMapper;
    private final SubagentExecutionMapper executionMapper;
    private final ObjectMapper objectMapper;

    @Transactional
    public Message persistAssistant(Long sessionId, String content, String thinkingContent,
                                    int tokenCount, Long modelId) {
        Message assistant = message(sessionId, "ASSISTANT", content, tokenCount, modelId);
        assistant.setThinkingContent(thinkingContent);
        messageMapper.insert(assistant);
        SubagentExecution execution = executionMapper.selectOne(
                new LambdaQueryWrapper<SubagentExecution>()
                        .eq(SubagentExecution::getChildSessionId, sessionId)
                        .in(SubagentExecution::getStatus, "RUNNING", "RECOVERING")
                        .orderByDesc(SubagentExecution::getId).last("LIMIT 1 FOR UPDATE"));
        if (execution != null) {
            execution.setFinalMessageId(assistant.getId());
            executionMapper.updateById(execution);
        }
        sessionMapper.updateById(sessionMapper.selectById(sessionId));
        return assistant;
    }

    @Transactional
    public Message persistToolRound(Long sessionId, String content, String thinkingContent,
                                    List<ChatRequest.ToolCall> toolCalls,
                                    List<AgentLoop.ToolMessageSave> toolMessages,
                                    int tokenCount, Long modelId) {
        Message assistant = message(sessionId, "ASSISTANT", content, tokenCount, modelId);
        assistant.setThinkingContent(thinkingContent);
        assistant.setToolCalls(writeJson(toolCalls));
        messageMapper.insert(assistant);

        for (AgentLoop.ToolMessageSave save : toolMessages) {
            Message tool = message(sessionId, "TOOL", save.content(), 0, null);
            tool.setToolCallId(save.toolCallId());
            tool.setMetadata(save.metadataJson());
            messageMapper.insert(tool);
        }

        Set<String> ids = toolCalls.stream().map(ChatRequest.ToolCall::getId)
                .filter(id -> id != null && !id.isBlank()).collect(Collectors.toSet());
        if (!ids.isEmpty()) {
            List<SubagentExecution> executions = executionMapper.selectList(
                    new LambdaQueryWrapper<SubagentExecution>()
                            .eq(SubagentExecution::getParentSessionId, sessionId)
                            .in(SubagentExecution::getParentToolCallId, ids)
                            .eq(SubagentExecution::getDeliveryStatus, "PENDING"));
            for (SubagentExecution execution : executions) {
                Message tool = toolMessages.stream()
                        .filter(save -> execution.getParentToolCallId().equals(save.toolCallId()))
                        .map(save -> messageMapper.selectOne(new LambdaQueryWrapper<Message>()
                                .eq(Message::getSessionId, sessionId)
                                .eq(Message::getRole, "TOOL")
                                .eq(Message::getToolCallId, save.toolCallId())
                                .orderByDesc(Message::getId).last("LIMIT 1")))
                        .findFirst().orElse(null);
                execution.setDeliveryStatus("DELIVERED");
                execution.setParentResultDeliveredAt(LocalDateTime.now());
                execution.setParentAssistantMessageId(assistant.getId());
                execution.setParentToolMessageId(tool != null ? tool.getId() : null);
                executionMapper.updateById(execution);
            }
        }
        sessionMapper.updateById(sessionMapper.selectById(sessionId));
        return assistant;
    }

    private Message message(Long sessionId, String role, String content, int tokenCount, Long modelId) {
        Message message = new Message();
        message.setSessionId(sessionId);
        message.setRole(role);
        message.setContent(content);
        message.setTokenCount(tokenCount);
        message.setModelId(modelId);
        return message;
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to serialize tool calls", e);
        }
    }
}
