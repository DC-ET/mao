package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.mcp.McpClient;
import com.agentworkbench.harness.mcp.McpTool;
import com.agentworkbench.harness.skill.Skill;
import com.agentworkbench.harness.skill.SkillRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Harness 服务 - 协调 Agent 执行
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class HarnessService {

    private final AgentLoop agentLoop;
    private final SkillRegistry skillRegistry;
    private final McpClient mcpClient;

    /**
     * 执行 Agent
     *
     * @param sessionId 会话 ID
     * @param eventId   事件 ID
     * @param listener  事件监听器
     */
    public void execute(Long sessionId, String eventId, AgentEventListener listener) {
        // 1. Load session and agent config from database
        // TODO: Implement database loading

        // 2. Build execution context
        AgentExecutionContext context = buildContext(sessionId);

        // 3. Execute agent loop
        agentLoop.execute(context, listener);
    }

    /**
     * 构建执行上下文
     */
    private AgentExecutionContext buildContext(Long sessionId) {
        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(sessionId);

        // TODO: Load from database
        // 1. Load session -> get agentId, userId
        // 2. Load agent -> get systemPrompt, modelId, skillIds, mcpConfigs
        // 3. Load model config -> get baseUrl, apiKey, modelId
        // 4. Load skills -> get Skill instances
        // 5. Load MCP tools -> get McpTool instances
        // 6. Load message history

        // Placeholder values
        context.setSystemPrompt("You are a helpful assistant.");
        context.setMaxRounds(10);
        context.setModelConfig(LlmModelConfig.builder()
                .id(1L)
                .name("gpt-4o")
                .baseUrl("https://api.openai.com/v1")
                .apiKey("sk-placeholder")
                .modelId("gpt-4o")
                .maxTokens(4096)
                .build());

        // Load available skills
        List<Skill> skills = skillRegistry.getAllSkills();
        context.setSkills(skills);

        // Load MCP tools
        // TODO: Load MCP configs from database and connect
        List<McpTool> mcpTools = new ArrayList<>();
        context.setMcpTools(mcpTools);

        return context;
    }
}
