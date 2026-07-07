package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.Message;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class MessageHistoryNormalizerTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void normalizeChatMessagesMovesToolsAfterAssistantCallsAndDropsOrphans() {
        ChatRequest.Message user = ChatRequest.Message.builder().role("user").content("hi").build();
        ChatRequest.Message tool = ChatRequest.Message.builder().role("tool").toolCallId("call-1").content("ok").build();
        ChatRequest.Message orphan = ChatRequest.Message.builder().role("tool").toolCallId("missing").content("orphan").build();
        ChatRequest.Message assistant = ChatRequest.Message.builder()
                .role("assistant")
                .toolCalls(List.of(ChatRequest.ToolCall.builder().id("call-1").build()))
                .build();

        List<ChatRequest.Message> normalized = MessageHistoryNormalizer.normalizeChatMessages(
                List.of(user, tool, orphan, assistant)
        );

        assertThat(normalized).containsExactly(user, assistant, tool);
    }

    @Test
    void normalizeChatMessagesReturnsOriginalWhenNoWorkNeeded() {
        List<ChatRequest.Message> one = List.of(ChatRequest.Message.builder().role("user").content("hi").build());

        assertThat(MessageHistoryNormalizer.normalizeChatMessages(null)).isNull();
        assertThat(MessageHistoryNormalizer.normalizeChatMessages(one)).isSameAs(one);
    }

    @Test
    void normalizeEntitiesMovesToolsAfterAssistantCalls() throws Exception {
        Message user = entity("USER", null, null);
        Message tool = entity("TOOL", "call-1", null);
        Message assistant = entity("ASSISTANT", null, objectMapper.writeValueAsString(List.of(
                ChatRequest.ToolCall.builder().id("call-1").build()
        )));
        Message orphan = entity("TOOL", "missing", null);

        List<Message> normalized = MessageHistoryNormalizer.normalizeEntities(
                List.of(user, tool, orphan, assistant),
                objectMapper
        );

        assertThat(normalized).containsExactly(user, assistant, tool);
    }

    @Test
    void normalizeEntitiesDropsToolsWhenToolCallsJsonIsInvalid() {
        Message assistant = entity("ASSISTANT", null, "not-json");
        Message tool = entity("TOOL", "call-1", null);

        List<Message> normalized = MessageHistoryNormalizer.normalizeEntities(List.of(tool, assistant), objectMapper);

        assertThat(normalized).containsExactly(assistant);
    }

    private Message entity(String role, String toolCallId, String toolCalls) {
        Message message = new Message();
        message.setRole(role);
        message.setToolCallId(toolCallId);
        message.setToolCalls(toolCalls);
        return message;
    }
}
