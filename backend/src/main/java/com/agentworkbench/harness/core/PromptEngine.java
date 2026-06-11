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

    private static final Set<String> TASK_TOOL_NAMES = Set.of(
            "task_create", "task_update", "task_list", "task_delete");

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
        sb.append("## 工作环境\n\n");
        sb.append("你当前的工作目录是：`").append(effectiveWorkspace).append("`\n");
        sb.append("所有相对文件路径都会基于该目录解析。\n");
        sb.append("- 是否为 git 仓库：").append(formatBoolean(context.getIsGit())).append("\n");
        sb.append("- 平台：").append(formatValue(context.getPlatform())).append("\n");
        sb.append("- Shell：").append(formatValue(context.getShellPath())).append("\n");
        sb.append("- 操作系统版本：").append(formatValue(context.getOsVersion())).append("\n");
        appendExecutionEnvironmentHint(sb, context, effectiveWorkspace);

        // Current time
        if (context.getCurrentTimestamp() != null) {
            sb.append("## 当前时间\n\n");
            sb.append("当前日期和时间：`").append(context.getCurrentTimestamp()).append("`\n\n");
        }

        // Skill catalog — inject name/description with workspace-relative paths
        List<String> skillNames = context.getAvailableSkillNames();
        if (skillNames != null && !skillNames.isEmpty()) {
            String catalog = buildRelativeSkillCatalog(context);
            if (catalog != null && !catalog.isEmpty()) {
                sb.append("## 可用技能\n\n");
                sb.append("以下技能可用。每个技能都是一份知识文档，用于指导你在特定场景下高效使用工具。\n");
                sb.append("技能会同步到工作区的 `.workbench/skills/` 目录下。\n");
                sb.append("如需阅读某个技能的完整内容，请使用 `read_file` 工具读取下方列出的文件路径。\n\n");
                sb.append(catalog);
                sb.append("\n\n");
            }
        }

        // Task management behavior hints
        appendToolBehaviorHints(sb, context);

        return sb.toString();
    }

    private String buildRelativeSkillCatalog(AgentExecutionContext context) {
        List<String> names = context.getAvailableSkillNames();
        if (names == null || names.isEmpty()) {
            names = skillLoader.getAllNames();
        }
        if (names.isEmpty()) {
            return null;
        }

        var skillDocs = context.getAvailableSkillDocs();
        StringBuilder sb = new StringBuilder();
        for (String name : names) {
            String description = "";
            var doc = skillDocs != null ? skillDocs.get(name) : null;
            if (doc == null) {
                doc = skillLoader.getAllDocuments().stream()
                        .filter(d -> d.getName().equals(name))
                        .findFirst().orElse(null);
            }
            if (doc != null && doc.getDescription() != null) {
                description = doc.getDescription();
            }
            sb.append("- **").append(name).append("**：");
            sb.append(description);
            sb.append("\n  目录：`.workbench/skills/").append(name).append("`");
            sb.append("\n  文件：`.workbench/skills/").append(name).append("/SKILL.md`");
            sb.append("\n");
        }
        return sb.toString().trim();
    }

    private void appendExecutionEnvironmentHint(StringBuilder sb, AgentExecutionContext context, String effectiveWorkspace) {
        String executionMode = context.getExecutionMode();
        if ("LOCAL".equalsIgnoreCase(executionMode)) {
            sb.append("当前会话处于 LOCAL 本地模式。你调用的 shell、文件读取、文件写入和文件搜索等工具会委托给用户桌面客户端执行，");
            sb.append("工作目录位于用户本地机器：`").append(effectiveWorkspace).append("`。\n");
            sb.append("因此，工具看到的文件系统、命令、依赖和环境变量属于用户本地环境。");
            sb.append("当描述执行过程或诊断异常时，请明确这是用户本地工作区中的情况。\n\n");
            return;
        }

        sb.append("当前会话处于 CLOUD 云端模式。你调用的 shell、文件读取、文件写入和文件搜索等工具都在云端服务器执行，");
        sb.append("工作目录是服务器上的临时/隔离目录，而不是用户电脑上的目录。\n");
        sb.append("因此，工具看到的文件系统、命令、依赖和环境变量都属于云端执行环境。");
        sb.append("当命令失败、文件不存在、依赖缺失或权限受限时，请先将其理解为云端工作区的问题，");
        sb.append("不要默认归因于用户本地电脑，也不要要求用户在本地手动执行命令来规避异常，除非用户明确要求或任务确实需要本地操作。\n\n");
    }

    private String formatBoolean(Boolean value) {
        if (value == null) return "未知";
        return value ? "是" : "否";
    }

    private String formatValue(String value) {
        return value != null && !value.isBlank() ? value : "未知";
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

    /**
     * 向 system prompt 注入任务管理行为指令
     */
    private void appendToolBehaviorHints(StringBuilder sb, AgentExecutionContext context) {
        boolean hasTaskTool = context.getTools().stream()
                .anyMatch(t -> TASK_TOOL_NAMES.contains(t.getName()));
        if (!hasTaskTool) return;

        sb.append("## 任务管理\n\n");
        sb.append("这些工具有助于规划你的工作，并帮助用户跟踪进展。\n");
        sb.append("只有当请求包含 3 个或更多明确步骤时，才使用任务工具。\n");
        sb.append("不要为简单、单步或直接明了的请求创建任务。\n");
        sb.append("使用任务时：每完成一个任务，就立即将其标记为已完成。\n");
        sb.append("不要等多个任务都做完后再批量标记完成。\n\n");
    }

}
