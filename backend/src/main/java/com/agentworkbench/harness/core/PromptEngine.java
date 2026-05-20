package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.skill.Skill;
import com.agentworkbench.harness.mcp.McpTool;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Prompt 构建引擎
 * 根据 Agent 配置（人格、系统提示词、Skills）构建完整的 Prompt
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PromptEngine {

    /**
     * 构建 LLM 请求
     */
    public ChatRequest buildRequest(AgentExecutionContext context) {
        List<ChatRequest.Message> messages = new ArrayList<>();

        // 1. System prompt (agent personality + tool descriptions)
        String systemPrompt = buildSystemPrompt(context);
        messages.add(ChatRequest.Message.builder()
                .role("system")
                .content(systemPrompt)
                .build());

        // 2. Conversation history (managed by ContextManager)
        messages.addAll(context.getMessages());

        // 3. Build tool definitions
        List<ChatRequest.ToolDefinition> tools = buildToolDefinitions(context);

        return ChatRequest.builder()
                .messages(messages)
                .tools(tools.isEmpty() ? null : tools)
                .stream(true)
                .build();
    }

    private String buildSystemPrompt(AgentExecutionContext context) {
        StringBuilder sb = new StringBuilder();

        // Agent personality / system prompt
        if (context.getSystemPrompt() != null && !context.getSystemPrompt().isEmpty()) {
            sb.append(context.getSystemPrompt());
            sb.append("\n\n");
        }

        // Tool descriptions
        List<Skill> skills = context.getSkills();
        List<McpTool> mcpTools = context.getMcpTools();

        if (!skills.isEmpty() || !mcpTools.isEmpty()) {
            sb.append("## Available Tools\n\n");

            for (Skill skill : skills) {
                sb.append("- **").append(skill.getName()).append("**: ");
                sb.append(skill.getDescription()).append("\n");
            }

            for (McpTool tool : mcpTools) {
                sb.append("- **").append(tool.getName()).append("**: ");
                sb.append(tool.getDescription()).append("\n");
            }
        }

        return sb.toString();
    }

    private List<ChatRequest.ToolDefinition> buildToolDefinitions(AgentExecutionContext context) {
        List<ChatRequest.ToolDefinition> tools = new ArrayList<>();

        // Skills as tools
        for (Skill skill : context.getSkills()) {
            tools.add(ChatRequest.ToolDefinition.builder()
                    .type("function")
                    .function(ChatRequest.Function.builder()
                            .name(skill.getName())
                            .description(skill.getDescription())
                            .parameters(skill.getInputSchema())
                            .build())
                    .build());
        }

        // MCP tools
        for (McpTool mcpTool : context.getMcpTools()) {
            tools.add(ChatRequest.ToolDefinition.builder()
                    .type("function")
                    .function(ChatRequest.Function.builder()
                            .name(mcpTool.getName())
                            .description(mcpTool.getDescription())
                            .parameters(mcpTool.getInputSchema())
                            .build())
                    .build());
        }

        return tools;
    }
}
