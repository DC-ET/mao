package com.agentworkbench.harness.llm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Builder;
import lombok.Data;

import java.util.List;
import java.util.Map;

@Data
@Builder
@JsonIgnoreProperties(ignoreUnknown = true)
public class ChatRequest {

    private List<Message> messages;
    private List<ToolDefinition> tools;
    private Double temperature;
    private Integer maxTokens;
    private Boolean stream;

    @Data
    @Builder
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Message {
        private String role;      // system, user, assistant, tool
        private Object content;   // String (plain text) or List<ContentPart> (multimodal)
        private String name;
        @JsonProperty("tool_call_id")
        private String toolCallId;
        @JsonProperty("tool_calls")
        private List<ToolCall> toolCalls;
    }

    @Data
    @Builder
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ContentPart {
        private String type;              // "text" or "image_url"
        private String text;              // type=text
        @JsonProperty("image_url")
        private ImageUrl imageUrl;        // type=image_url
    }

    @Data
    @Builder
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ImageUrl {
        private String url;
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
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ToolCall {
        private String id;
        private String type;      // "function"
        private FunctionCall function;
        private String summary;
    }

    @Data
    @Builder
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class FunctionCall {
        private String name;
        private String arguments;
    }
}
