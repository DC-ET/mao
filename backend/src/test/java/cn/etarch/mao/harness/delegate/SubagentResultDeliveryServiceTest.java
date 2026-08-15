package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SubagentResultDeliveryServiceTest {

    private final SubagentExecutionMapper executionMapper = mock(SubagentExecutionMapper.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final MessageMapper messageMapper = mock(MessageMapper.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final SubagentResultDeliveryService service = new SubagentResultDeliveryService(
            executionMapper, sessionMapper, messageMapper, objectMapper,
            new SubagentRecoveryResultFactory(objectMapper));

    @Test
    void deliversLegacyExecutionAsLegalAssistantToolPair() throws Exception {
        SubagentExecution execution = execution(9L, "COMPLETED");
        when(executionMapper.selectByIdForUpdate(9L)).thenReturn(execution);
        when(executionMapper.selectFirstByChildSessionId(20L)).thenReturn(execution);
        when(sessionMapper.lockActiveSessionById(10L)).thenReturn(10L);
        when(sessionMapper.selectById(10L)).thenReturn(parent("RUNNING"));
        when(messageMapper.selectList(any())).thenReturn(List.of());

        assertThat(service.deliver(9L)).isTrue();

        ArgumentCaptor<Message> messages = ArgumentCaptor.forClass(Message.class);
        verify(messageMapper, org.mockito.Mockito.times(2)).insert(messages.capture());
        Message assistant = messages.getAllValues().get(0);
        Message tool = messages.getAllValues().get(1);
        JsonNode calls = objectMapper.readTree(assistant.getToolCalls());
        assertThat(assistant.getRole()).isEqualTo("ASSISTANT");
        assertThat(calls.get(0).get("id").asText()).isEqualTo("recovered_subagent_execution_9");
        assertThat(calls.get(0).get("function").get("name").asText()).isEqualTo("delegate");
        assertThat(tool.getRole()).isEqualTo("TOOL");
        assertThat(tool.getToolCallId()).isEqualTo("recovered_subagent_execution_9");
        assertThat(tool.getSourceSessionId()).isEqualTo(20L);
        assertThat(execution.getDeliveryStatus()).isEqualTo("DELIVERED");
        assertThat(execution.getInvocationType()).isEqualTo("DELEGATE");
    }

    @Test
    void existingCompletePairOnlyMarksDelivered() throws Exception {
        SubagentExecution execution = execution(9L, "COMPLETED");
        execution.setInvocationType("FOLLOWUP");
        execution.setParentToolCallId("call-9");
        Message assistant = new Message();
        assistant.setId(101L);
        assistant.setRole("ASSISTANT");
        assistant.setToolCalls("[{\"id\":\"call-9\",\"type\":\"function\",\"function\":{\"name\":\"delegate_followup\",\"arguments\":\"{}\"}}]");
        Message tool = new Message();
        tool.setId(102L);
        tool.setRole("TOOL");
        tool.setToolCallId("call-9");
        when(executionMapper.selectByIdForUpdate(9L)).thenReturn(execution);
        when(sessionMapper.lockActiveSessionById(10L)).thenReturn(10L);
        when(sessionMapper.selectById(10L)).thenReturn(parent("RUNNING"));
        when(messageMapper.selectList(any())).thenReturn(List.of(assistant, tool));

        assertThat(service.deliver(9L)).isTrue();

        verify(messageMapper, never()).insert(any());
        assertThat(execution.getDeliveryStatus()).isEqualTo("DELIVERED");
        assertThat(execution.getParentAssistantMessageId()).isEqualTo(101L);
        assertThat(execution.getParentToolMessageId()).isEqualTo(102L);
    }

    @Test
    void terminalParentSuppressesAllPendingResults() {
        SubagentExecution first = execution(9L, "COMPLETED");
        SubagentExecution second = execution(10L, "FAILED");
        when(executionMapper.selectByIdForUpdate(9L)).thenReturn(first);
        when(sessionMapper.lockActiveSessionById(10L)).thenReturn(10L);
        when(sessionMapper.selectById(10L)).thenReturn(parent("CANCELLED"));
        when(executionMapper.selectList(any())).thenReturn(List.of(first, second));

        assertThat(service.deliver(9L)).isFalse();

        assertThat(first.getDeliveryStatus()).isEqualTo("SUPPRESSED");
        assertThat(second.getDeliveryStatus()).isEqualTo("SUPPRESSED");
        verify(messageMapper, never()).insert(any());
    }

    private SubagentExecution execution(Long id, String status) {
        SubagentExecution execution = new SubagentExecution();
        execution.setId(id);
        execution.setParentSessionId(10L);
        execution.setChildSessionId(20L);
        execution.setAgentType("reviewer");
        execution.setTaskDescription("review");
        execution.setStatus(status);
        execution.setDeliveryStatus("PENDING");
        execution.setResult("done");
        return execution;
    }

    private Session parent(String phase) {
        Session session = new Session();
        session.setId(10L);
        session.setPhase(phase);
        return session;
    }
}
