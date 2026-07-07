package cn.etarch.mao.harness.llm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class StreamChunk {

    private String id;
    private String model;
    private List<DeltaChoice> choices;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class DeltaChoice {
        private int index;
        private Delta delta;
        @JsonProperty("finish_reason")
        private String finishReason;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Delta {
        private String role;
        private String content;
        @JsonProperty("tool_calls")
        private List<ChatRequest.ToolCall> toolCalls;
        @JsonProperty("reasoning_content")
        private String reasoningContent;
    }
}
