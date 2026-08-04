package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.service.SessionService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 会话历史加载与应用到执行上下文（纯加载/应用，无压缩副作用）。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionHistoryLoader {

    private final SessionService sessionService;
    private final ContextManager contextManager;
    private final ObjectMapper objectMapper;

    public HistorySnapshot loadHistoryAfterBoundary(Long sessionId, long boundary) {
        List<Message> rawMessages = sessionService.getMessagesAfterId(sessionId, boundary);
        List<Long> snapshotMessageIds = rawMessages.stream().map(Message::getId).toList();
        List<Message> normalized = MessageHistoryNormalizer.normalizeEntities(rawMessages, objectMapper);
        List<PersistedChatMessage> persistedMessages = normalized.stream()
                .map(message -> new PersistedChatMessage(
                        message.getId(), message.getContent(), toChatMessage(message)))
                .toList();
        return new HistorySnapshot(snapshotMessageIds, normalized, persistedMessages);
    }

    /**
     * 用摘要 + DB 增量替换 context.messages（clear+addAll，不替换列表引用），
     * 并按原顺序复原内存态 system 消息（后台任务结果 / MCP 降级提示等）。
     */
    public void applyHistory(AgentExecutionContext context, String summary, HistorySnapshot history) {
        List<ChatRequest.Message> incrementalMessages = history.persistedMessages().stream()
                .map(PersistedChatMessage::chatMessage)
                .toList();
        context.getMessages().clear();
        context.getMessages().addAll(contextManager.prependSessionSummary(summary, incrementalMessages));
        // 复原从未落库的 ephemeral system 消息（语义上位于列表尾部）
        if (context.getEphemeralSystemMessages() != null && !context.getEphemeralSystemMessages().isEmpty()) {
            context.getMessages().addAll(context.getEphemeralSystemMessages());
        }
        context.setSessionSummary(summary);
        context.getToolAttachments().clear();
        context.getToolAttachments().putAll(
                ToolAttachmentLoader.loadAllFromMessages(history.normalizedEntities(), objectMapper));
    }

    public ChatRequest.Message toChatMessage(Message message) {
        var builder = ChatRequest.Message.builder()
                .role(message.getRole().toLowerCase())
                .content(parseContent(message.getContent()));
        if (message.getToolCallId() != null) {
            builder.toolCallId(message.getToolCallId());
        }
        if (message.getToolCalls() != null && !message.getToolCalls().isEmpty()) {
            try {
                builder.toolCalls(objectMapper.readValue(
                        message.getToolCalls(), new TypeReference<List<ChatRequest.ToolCall>>() {}));
            } catch (JsonProcessingException e) {
                log.warn("Failed to parse tool_calls for message {}", message.getId(), e);
            }
        }
        return builder.build();
    }

    private Object parseContent(String raw) {
        if (raw == null) return "";
        String trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
            try {
                return objectMapper.readValue(trimmed,
                        new TypeReference<List<ChatRequest.ContentPart>>() {});
            } catch (Exception e) {
                return raw;
            }
        }
        return raw;
    }

    public record HistorySnapshot(
            List<Long> snapshotMessageIds,
            List<Message> normalizedEntities,
            List<PersistedChatMessage> persistedMessages) {
    }
}
