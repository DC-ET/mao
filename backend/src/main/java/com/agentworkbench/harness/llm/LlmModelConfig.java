package com.agentworkbench.harness.llm;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class LlmModelConfig {

    private Long id;
    private String name;
    private String provider;
    private String baseUrl;
    private String apiKey;
    private String modelId;
    private Integer maxTokens;
    private Double temperatureMax;
}
