package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.skill.SkillLoader;
import com.agentworkbench.harness.tool.Tool;
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

        // 2. Conversation history (may include compaction summaries injected as system messages)
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
        sb.append("All relative file paths are resolved against this directory.\n\n");

        // Current time
        if (context.getCurrentTimestamp() != null) {
            sb.append("## Current Time\n\n");
            sb.append("Current date and time: `").append(context.getCurrentTimestamp()).append("`\n\n");
        }

        // Skill catalog — inject name/description with workspace-relative paths
        List<String> skillNames = context.getAvailableSkillNames();
        if (skillNames != null && !skillNames.isEmpty()) {
            String catalog = buildRelativeSkillCatalog(skillNames);
            if (catalog != null && !catalog.isEmpty()) {
                sb.append("## Available Skills\n\n");
                sb.append("The following skills are available. Each skill is a knowledge document that provides ");
                sb.append("guidance on how to use tools effectively in specific scenarios.\n");
                sb.append("Skills are synced to your workspace under `.workbench/skills/` directory.\n");
                sb.append("To read a skill's full content, use the `read_file` tool with the file path listed below.\n\n");
                sb.append(catalog);
                sb.append("\n\n");
            }
        }

        return sb.toString();
    }

    private String buildRelativeSkillCatalog(List<String> filterNames) {
        List<String> names = filterNames != null && !filterNames.isEmpty()
                ? filterNames
                : skillLoader.getAllNames();
        if (names.isEmpty()) {
            return null;
        }

        StringBuilder sb = new StringBuilder();
        for (String name : names) {
            if (!skillLoader.hasSkill(name)) continue;
            String description = "";
            var doc = skillLoader.getAllDocuments().stream()
                    .filter(d -> d.getName().equals(name))
                    .findFirst().orElse(null);
            if (doc != null && doc.getDescription() != null) {
                description = doc.getDescription();
            }
            sb.append("- **").append(name).append("**: ");
            sb.append(description);
            sb.append("\n  Folder: `.workbench/skills/").append(name).append("`");
            sb.append("\n  File: `.workbench/skills/").append(name).append("/SKILL.md`");
            sb.append("\n");
        }
        return sb.toString().trim();
    }

    private List<ChatRequest.ToolDefinition> buildToolDefinitions(AgentExecutionContext context) {
        List<ChatRequest.ToolDefinition> tools = new ArrayList<>();

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

        return tools;
    }
}
