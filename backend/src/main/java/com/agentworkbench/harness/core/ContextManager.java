package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 上下文窗口管理器
 * 管理对话上下文、滑动窗口、摘要压缩
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ContextManager {

    private static final int DEFAULT_MAX_CONTEXT_TOKENS = 8000;
    private static final int DEFAULT_KEEP_ROUNDS = 10;
    private static final int CHARS_PER_TOKEN = 4; // rough estimate

    /**
     * Check if context needs compression
     */
    public boolean needsCompression(AgentExecutionContext context, int maxContextTokens) {
        if (maxContextTokens <= 0) {
            maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;
        }
        int estimatedTokens = estimateTokens(context.getMessages());
        return estimatedTokens > maxContextTokens;
    }

    /**
     * Compress context using sliding window strategy
     * Keep system prompt + last N rounds, summarize older messages
     */
    public List<ChatRequest.Message> compress(AgentExecutionContext context, int keepRounds) {
        List<ChatRequest.Message> messages = context.getMessages();
        if (messages == null || messages.isEmpty()) {
            return messages;
        }

        if (keepRounds <= 0) {
            keepRounds = DEFAULT_KEEP_ROUNDS;
        }

        // Find system message
        ChatRequest.Message systemMsg = null;
        List<ChatRequest.Message> nonSystemMessages = new ArrayList<>();
        for (ChatRequest.Message msg : messages) {
            if ("system".equals(msg.getRole())) {
                systemMsg = msg;
            } else {
                nonSystemMessages.add(msg);
            }
        }

        // If messages are short enough, no compression needed
        if (nonSystemMessages.size() <= keepRounds * 2) {
            return messages;
        }

        // Split into old (to summarize) and recent (to keep)
        int splitIndex = nonSystemMessages.size() - keepRounds * 2;
        List<ChatRequest.Message> oldMessages = nonSystemMessages.subList(0, splitIndex);
        List<ChatRequest.Message> recentMessages = nonSystemMessages.subList(splitIndex, nonSystemMessages.size());

        // Generate summary of old messages
        String summary = generateSummary(oldMessages);

        // Build compressed context
        List<ChatRequest.Message> compressed = new ArrayList<>();
        if (systemMsg != null) {
            // Append summary to system message
            String enhancedSystem = systemMsg.getContent()
                    + "\n\n[历史对话摘要]\n" + summary;
            compressed.add(ChatRequest.Message.builder()
                    .role("system")
                    .content(enhancedSystem)
                    .build());
        } else {
            // Add summary as system message
            compressed.add(ChatRequest.Message.builder()
                    .role("system")
                    .content("[历史对话摘要]\n" + summary)
                    .build());
        }
        compressed.addAll(recentMessages);

        log.info("Context compressed: {} messages -> {} messages ({} old messages summarized)",
                messages.size(), compressed.size(), oldMessages.size());

        return compressed;
    }

    /**
     * Micro-compact: replace old tool results with placeholders to save context space.
     * Keeps the last keepRounds rounds of tool results intact.
     */
    public void microCompact(AgentExecutionContext context, int keepRounds) {
        List<ChatRequest.Message> messages = context.getMessages();
        if (messages == null || messages.size() <= keepRounds * 2) {
            return;
        }

        // Find the cutoff: keep last keepRounds*2 non-system messages intact
        int nonSystemCount = 0;
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (!"system".equals(messages.get(i).getRole())) {
                nonSystemCount++;
            }
        }

        if (nonSystemCount <= keepRounds * 2) {
            return;
        }

        int cutoff = nonSystemCount - keepRounds * 2;
        int seen = 0;
        for (int i = 0; i < messages.size(); i++) {
            ChatRequest.Message msg = messages.get(i);
            if ("system".equals(msg.getRole())) continue;
            seen++;

            if (seen <= cutoff && "tool".equals(msg.getRole()) && msg.getToolCallId() != null) {
                // Replace old tool result with placeholder
                messages.set(i, ChatRequest.Message.builder()
                        .role("tool")
                        .toolCallId(msg.getToolCallId())
                        .content("[Previous tool result omitted]")
                        .build());
            }
        }

        log.debug("Micro-compacted: replaced old tool results with placeholders");
    }

    /**
     * Estimate token count for messages
     */
    public int estimateTokens(List<ChatRequest.Message> messages) {
        if (messages == null) return 0;
        int totalChars = 0;
        for (ChatRequest.Message msg : messages) {
            if (msg.getContent() != null) {
                totalChars += msg.getContent().length();
            }
        }
        return totalChars / CHARS_PER_TOKEN;
    }

    /**
     * Generate a summary of old messages
     */
    private String generateSummary(List<ChatRequest.Message> messages) {
        StringBuilder sb = new StringBuilder();
        for (ChatRequest.Message msg : messages) {
            String role = "user".equals(msg.getRole()) ? "用户" : "助手";
            String content = msg.getContent();
            if (content != null && !content.isEmpty()) {
                // Truncate long messages
                if (content.length() > 200) {
                    content = content.substring(0, 200) + "...";
                }
                sb.append(role).append(": ").append(content).append("\n");
            }
        }
        return sb.toString();
    }
}
