package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.session.entity.Message;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Ensures tool messages immediately follow the assistant message that issued their tool_calls.
 * <p>
 * During parallel tool execution, tool results may be persisted before the assistant message,
 * which breaks OpenAI message ordering when history is reloaded from DB.
 */
@Slf4j
public final class MessageHistoryNormalizer {

    private MessageHistoryNormalizer() {
    }

    public static List<Message> normalizeEntities(List<Message> messages, ObjectMapper objectMapper) {
        if (messages == null || messages.size() < 2) {
            return messages;
        }

        Map<String, Message> deferredTools = collectDeferredToolMessages(messages);
        if (deferredTools.isEmpty()) {
            return messages;
        }

        List<Message> normalized = new ArrayList<>(messages.size());
        for (Message msg : messages) {
            if ("TOOL".equals(msg.getRole())) {
                continue;
            }
            normalized.add(msg);
            if ("ASSISTANT".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                appendMatchingToolMessages(normalized, deferredTools, extractToolCallIds(msg.getToolCalls(), objectMapper));
            }
        }

        if (!deferredTools.isEmpty()) {
            log.warn("Dropping {} orphaned tool messages without a preceding assistant tool_calls",
                    deferredTools.size());
        }
        return normalized;
    }

    public static List<ChatRequest.Message> normalizeChatMessages(List<ChatRequest.Message> messages) {
        if (messages == null || messages.size() < 2) {
            return messages;
        }

        Map<String, ChatRequest.Message> deferredTools = new LinkedHashMap<>();
        for (ChatRequest.Message msg : messages) {
            if ("tool".equals(msg.getRole()) && msg.getToolCallId() != null) {
                deferredTools.put(msg.getToolCallId(), msg);
            }
        }
        if (deferredTools.isEmpty()) {
            return messages;
        }

        List<ChatRequest.Message> normalized = new ArrayList<>(messages.size());
        for (ChatRequest.Message msg : messages) {
            if ("tool".equals(msg.getRole())) {
                continue;
            }
            normalized.add(msg);
            if ("assistant".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                for (ChatRequest.ToolCall toolCall : msg.getToolCalls()) {
                    if (toolCall.getId() == null) {
                        continue;
                    }
                    ChatRequest.Message toolMsg = deferredTools.remove(toolCall.getId());
                    if (toolMsg != null) {
                        normalized.add(toolMsg);
                    }
                }
            }
        }

        if (!deferredTools.isEmpty()) {
            log.warn("Dropping {} orphaned tool messages without a preceding assistant tool_calls",
                    deferredTools.size());
        }
        return normalized;
    }

    private static Map<String, Message> collectDeferredToolMessages(List<Message> messages) {
        Map<String, Message> deferredTools = new LinkedHashMap<>();
        for (Message msg : messages) {
            if ("TOOL".equals(msg.getRole()) && msg.getToolCallId() != null) {
                deferredTools.put(msg.getToolCallId(), msg);
            }
        }
        return deferredTools;
    }

    private static void appendMatchingToolMessages(List<Message> normalized,
                                                    Map<String, Message> deferredTools,
                                                    List<String> toolCallIds) {
        for (String toolCallId : toolCallIds) {
            Message toolMsg = deferredTools.remove(toolCallId);
            if (toolMsg != null) {
                normalized.add(toolMsg);
            }
        }
    }

    private static List<String> extractToolCallIds(String toolCallsJson, ObjectMapper objectMapper) {
        List<String> ids = new ArrayList<>();
        try {
            List<ChatRequest.ToolCall> toolCalls = objectMapper.readValue(
                    toolCallsJson, new TypeReference<List<ChatRequest.ToolCall>>() {});
            for (ChatRequest.ToolCall toolCall : toolCalls) {
                if (toolCall.getId() != null) {
                    ids.add(toolCall.getId());
                }
            }
        } catch (Exception e) {
            log.warn("Failed to parse tool_calls while normalizing message history: {}", e.getMessage());
        }
        return ids;
    }
}
