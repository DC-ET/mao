package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.skill.SkillLoader;
import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.harness.mcp.McpTool;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Prompt 构建引擎
 * 根据 Agent 配置（人格、系统提示词、Tools、Skills）构建完整的 Prompt
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PromptEngine {

    private final SkillLoader skillLoader;
    private final PathSandbox pathSandbox;

    /**
     * 构建 LLM 请求
     */
    public ChatRequest buildRequest(AgentExecutionContext context) {
        List<ChatRequest.Message> messages = new ArrayList<>();

        // 1. System prompt (agent personality + skill catalog + tool descriptions)
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

        // Workspace directory hint — always provide so the LLM never guesses
        String effectiveWorkspace = (context.getWorkspace() != null && !context.getWorkspace().isEmpty())
                ? context.getWorkspace()
                : pathSandbox.getWorkspaceRoot().toString();
        sb.append("## Working Directory\n\n");
        sb.append("Your current working directory is: `").append(effectiveWorkspace).append("`\n");
        sb.append("All relative file paths are resolved against this directory. Use `ls` or `read_file` to explore the project.\n\n");

        // Skill catalog (Layer 1) — name + description, ~100 token/skill
        String skillDescriptions = skillLoader.getDescriptions(context.getAvailableSkillNames());
        if (skillDescriptions != null && !skillDescriptions.isEmpty()) {
            sb.append("## Available Skills\n\n");
            sb.append(skillDescriptions);
            sb.append("\n\n");
            sb.append("Use the `load_skill` tool to load a skill's full content when you need domain-specific guidance.\n\n");
        }

        // Tool descriptions
        List<Tool> tools = context.getTools();
        List<McpTool> mcpTools = context.getMcpTools();

        if (!tools.isEmpty() || !mcpTools.isEmpty()) {
            sb.append("## Available Tools\n\n");

            for (Tool tool : tools) {
                sb.append("- **").append(tool.getName()).append("**: ");
                sb.append(tool.getDescription()).append("\n");
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

        // load_skill tool (Skill system entry point — Layer 2)
        if (!skillLoader.getAllNames().isEmpty()) {
            tools.add(ChatRequest.ToolDefinition.builder()
                    .type("function")
                    .function(ChatRequest.Function.builder()
                            .name("load_skill")
                            .description("Load the full knowledge content of a specified Skill. Call this when you need domain-specific guidance for a particular task area.")
                            .parameters(Map.of(
                                    "type", "object",
                                    "properties", Map.of("name", Map.of(
                                            "type", "string",
                                            "description", "The Skill name to load"
                                    )),
                                    "required", List.of("name")
                            ))
                            .build())
                    .build());
        }

        // Built-in tools
        for (Tool tool : context.getTools()) {
            tools.add(ChatRequest.ToolDefinition.builder()
                    .type("function")
                    .function(ChatRequest.Function.builder()
                            .name(tool.getName())
                            .description(tool.getDescription())
                            .parameters(tool.getInputSchema())
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
