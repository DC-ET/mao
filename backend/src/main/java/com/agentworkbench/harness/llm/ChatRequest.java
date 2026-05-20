package com.agentworkbench.harness.llm;

import lombok.Builder;
import lombok.Data;

import java.util.List;
import java.util.Map;

@Data
@Builder
public class ChatRequest {

    private List<Message> messages;
    private List<ToolDefinition> tools;
    private Double temperature;
    private Integer maxTokens;
    private Boolean stream;

    @Data
    @Builder
    public static class Message {
        private String role;      // system, user, assistant, tool
        private String content;
        private String name;
        private String toolCallId;
        private List<ToolCall> toolCalls;
    }

    @Data
    @Builder
    public static class ToolDefinition {
        private String type;      // "function"
        private Function function;
    }

    @Data
    @Builder
    public static class Function {
        private String name;
        private String description;
        private Map<String, Object> parameters;
    }

    @Data
    @Builder
    public static class ToolCall {
        private String id;
        private String type;      // "function"
        private FunctionCall function;
    }

    @Data
    @Builder
    public static class FunctionCall {
        private String name;
        private String arguments;
    }
}
