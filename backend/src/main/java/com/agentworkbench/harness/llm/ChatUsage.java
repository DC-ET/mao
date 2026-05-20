package com.agentworkbench.harness.llm;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class ChatUsage {

    private int promptTokens;
    private int completionTokens;
    private int totalTokens;
}
