package com.agentworkbench.harness.skill.impl;

import com.agentworkbench.harness.core.AgentExecutionContext;
import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.core.AgentLoop;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.skill.Skill;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

@Slf4j
@Component
public class SubagentSkill implements Skill {

    private static final int MAX_SUBAGENT_ROUNDS = 30;

    private final ObjectMapper objectMapper;
    private final AgentLoop agentLoop;

    public SubagentSkill(ObjectMapper objectMapper, AgentLoop agentLoop) {
        this.objectMapper = objectMapper;
        this.agentLoop = agentLoop;
    }

    @Override
    public String getName() {
        return "subagent";
    }

    @Override
    public String getDescription() {
        return "Delegate a subtask to an independent agent context. The subagent runs with its own message history and returns only the final result. Parameters: prompt (required), max_rounds (optional, default 10, max 30).";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("prompt", Map.of("type", "string", "description", "The task prompt for the subagent"));
        properties.put("max_rounds", Map.of("type", "integer", "description", "Maximum rounds (default 10, max 30)"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"prompt"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("result", Map.of("type", "string"));
        properties.put("rounds_used", Map.of("type", "integer"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String prompt = args.get("prompt").asText();
            int maxRounds = args.has("max_rounds") ? Math.min(args.get("max_rounds").asInt(), MAX_SUBAGENT_ROUNDS) : 10;

            // Create isolated context for subagent
            AgentExecutionContext subContext = new AgentExecutionContext();
            subContext.setMaxRounds(maxRounds);
            subContext.addUserMessage(prompt);

            // Collect final text output
            StringBuilder result = new StringBuilder();
            subContext.getMessages(); // ensure initialized

            agentLoop.execute(subContext, new AgentEventListener() {
                @Override
                public void onContentDelta(String delta) {
                    result.append(delta);
                }

                @Override
                public void onToolCallStart(ChatRequest.ToolCall toolCall) {
                    // no-op for subagent
                }

                @Override
                public void onToolCallResult(String toolCallId, String toolResult) {
                    // no-op for subagent
                }

                @Override
                public void onMessageEnd(ChatUsage usage) {
                    // no-op for subagent
                }

                @Override
                public void onError(Throwable t) {
                    log.error("Subagent error", t);
                }
            });

            return objectMapper.writeValueAsString(Map.of(
                    "result", result.toString(),
                    "rounds_used", subContext.getCurrentRound()
            ));
        } catch (Exception e) {
            log.error("SubagentSkill execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of("result", "Error: " + e.getMessage(), "rounds_used", 0));
            } catch (Exception ex) {
                return "{\"result\":\"Error: " + e.getMessage().replace("\"", "'") + "\",\"rounds_used\":0}";
            }
        }
    }
}
