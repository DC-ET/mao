package com.agentworkbench.harness.llm;

import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
public class StreamChunk {

    private String id;
    private String model;
    private List<DeltaChoice> choices;

    @Data
    @Builder
    public static class DeltaChoice {
        private int index;
        private Delta delta;
        private String finishReason;
    }

    @Data
    @Builder
    public static class Delta {
        private String role;
        private String content;
        private List<ChatRequest.ToolCall> toolCalls;
    }
}
