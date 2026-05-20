package com.agentworkbench.harness.llm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
@JsonIgnoreProperties(ignoreUnknown = true)
public class ChatResponse {

    private String id;
    private String model;
    private List<Choice> choices;
    private ChatUsage usage;

    @Data
    @Builder
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Choice {
        private int index;
        private ChatRequest.Message message;
        @JsonProperty("finish_reason")
        private String finishReason;  // stop, tool_calls, length
    }
}
