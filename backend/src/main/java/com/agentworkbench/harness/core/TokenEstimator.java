package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knuddels.jtokkit.Encodings;
import com.knuddels.jtokkit.api.Encoding;
import com.knuddels.jtokkit.api.EncodingRegistry;
import com.knuddels.jtokkit.api.EncodingType;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 基于 cl100k_base 编码器的 Token 精确估算器
 * 与 OpenAI GPT-3.5/GPT-4 系列模型使用相同的分词算法
 */
@Slf4j
@Component
public class TokenEstimator {

    private final Encoding encoding;
    private final ObjectMapper objectMapper;

    // OpenAI chat format overhead per message
    private static final int MESSAGE_OVERHEAD_TOKENS = 4; // <|start|>{role}\n...\n<|end|>\n

    public TokenEstimator(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        EncodingRegistry registry = Encodings.newDefaultEncodingRegistry();
        this.encoding = registry.getEncoding(EncodingType.CL100K_BASE);
        log.info("TokenEstimator initialized with cl100k_base encoding");
    }

    /**
     * 估算完整 ChatRequest 的 token 数（含 system prompt + messages + tool definitions）
     */
    public int estimateRequestTokens(ChatRequest request) {
        int total = 0;

        // Messages
        if (request.getMessages() != null) {
            total += estimateMessages(request.getMessages());
        }

        // Tool definitions
        if (request.getTools() != null && !request.getTools().isEmpty()) {
            total += estimateToolDefinitions(request.getTools());
        }

        return total;
    }

    /**
     * 估算消息列表的 token 数
     */
    public int estimateMessages(List<ChatRequest.Message> messages) {
        int total = 0;
        for (ChatRequest.Message msg : messages) {
            total += estimateMessage(msg);
        }
        return total;
    }

    /**
     * 估算单条消息的 token 数
     */
    public int estimateMessage(ChatRequest.Message message) {
        int tokens = MESSAGE_OVERHEAD_TOKENS;

        // Role name tokens
        if (message.getRole() != null) {
            tokens += countTokens(message.getRole());
        }

        // Content tokens
        if (message.getContent() != null) {
            tokens += countTokens(contentToString(message.getContent()));
        }

        // Tool call id tokens
        if (message.getToolCallId() != null) {
            tokens += countTokens(message.getToolCallId());
        }

        // Tool calls (assistant message with function calls)
        if (message.getToolCalls() != null) {
            for (ChatRequest.ToolCall tc : message.getToolCalls()) {
                tokens += estimateToolCall(tc);
            }
        }

        return tokens;
    }

    private int estimateToolCall(ChatRequest.ToolCall toolCall) {
        int tokens = 7; // tool_call structure overhead
        if (toolCall.getId() != null) {
            tokens += countTokens(toolCall.getId());
        }
        if (toolCall.getFunction() != null) {
            if (toolCall.getFunction().getName() != null) {
                tokens += countTokens(toolCall.getFunction().getName());
            }
            if (toolCall.getFunction().getArguments() != null) {
                tokens += countTokens(toolCall.getFunction().getArguments());
            }
        }
        return tokens;
    }

    /**
     * 估算 tool definitions 的 token 数
     */
    public int estimateToolDefinitions(List<ChatRequest.ToolDefinition> tools) {
        int total = 0;
        for (ChatRequest.ToolDefinition tool : tools) {
            total += estimateToolDefinition(tool);
        }
        // Format overhead for the tools array
        total += 12;
        return total;
    }

    private int estimateToolDefinition(ChatRequest.ToolDefinition tool) {
        int tokens = 7; // structure overhead
        if (tool.getType() != null) {
            tokens += countTokens(tool.getType());
        }
        if (tool.getFunction() != null) {
            ChatRequest.Function fn = tool.getFunction();
            if (fn.getName() != null) {
                tokens += countTokens(fn.getName());
            }
            if (fn.getDescription() != null) {
                tokens += countTokens(fn.getDescription());
            }
            if (fn.getParameters() != null) {
                try {
                    String json = objectMapper.writeValueAsString(fn.getParameters());
                    tokens += countTokens(json);
                } catch (Exception e) {
                    // fallback: rough estimate
                    tokens += fn.getParameters().size() * 20;
                }
            }
        }
        return tokens;
    }

    /**
     * Extract text from content (String or List<ContentPart>)
     */
    public static String contentToString(Object content) {
        if (content == null) return "";
        if (content instanceof String s) return s;
        if (content instanceof List<?> list) {
            StringBuilder sb = new StringBuilder();
            for (Object item : list) {
                if (item instanceof ChatRequest.ContentPart part) {
                    if ("text".equals(part.getType()) && part.getText() != null) {
                        sb.append(part.getText());
                    }
                } else if (item instanceof java.util.Map<?, ?> map) {
                    Object type = map.get("type");
                    if ("text".equals(type)) {
                        Object text = map.get("text");
                        if (text != null) sb.append(text);
                    }
                }
            }
            return sb.toString();
        }
        return content.toString();
    }

    /**
     * 使用 cl100k_base 编码器精确计算 token 数
     */
    public int countTokens(String text) {
        if (text == null || text.isEmpty()) {
            return 0;
        }
        try {
            return encoding.countTokens(text);
        } catch (Exception e) {
            log.warn("Token encoding failed, falling back to char estimate", e);
            return text.length() / 4;
        }
    }
}
