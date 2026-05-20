package com.agentworkbench.harness.llm;

import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
public class ChatResponse {

    private String id;
    private String model;
    private List<Choice> choices;
    private ChatUsage usage;

    @Data
    @Builder
    public static class Choice {
        private int index;
        private ChatRequest.Message message;
        private String finishReason;  // stop, tool_calls, length
    }
}
