package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.harness.mcp.McpTool;
import lombok.Data;

import java.util.*;

/**
 * Agent 执行上下文，包含一次对话的全部状态
 */
@Data
public class AgentExecutionContext {

    private Long sessionId;
    private Long userId;
    private Long agentId;

    // Agent 配置
    private String systemPrompt;
    private String agentName;
    private LlmModelConfig modelConfig;
    private int maxRounds;
    private String executionMode;

    // 对话消息历史
    private List<ChatRequest.Message> messages = new ArrayList<>();

    // 可用工具
    private List<Tool> tools = new ArrayList<>();
    private List<McpTool> mcpTools = new ArrayList<>();

    // 可用 Skill 知识文档名称列表（为空则加载全部）
    private List<String> availableSkillNames = new ArrayList<>();

    // 执行状态
    private List<ChatRequest.ToolCall> pendingToolCalls;
    private ChatUsage totalUsage;
    private int currentRound = 0;

    public AgentExecutionContext() {
        this.totalUsage = ChatUsage.builder()
                .promptTokens(0)
                .completionTokens(0)
                .totalTokens(0)
                .build();
    }

    public void addUserMessage(String content) {
        messages.add(ChatRequest.Message.builder()
                .role("user")
                .content(content)
                .build());
    }

    public void addSystemMessage(String content) {
        messages.add(ChatRequest.Message.builder()
                .role("system")
                .content(content)
                .build());
    }

    public void addAssistantMessage(String content, List<ChatRequest.ToolCall> toolCalls) {
        messages.add(ChatRequest.Message.builder()
                .role("assistant")
                .content(content)
                .toolCalls(toolCalls != null && !toolCalls.isEmpty() ? toolCalls : null)
                .build());
    }

    public void addToolResult(String toolCallId, String result) {
        messages.add(ChatRequest.Message.builder()
                .role("tool")
                .toolCallId(toolCallId)
                .content(result)
                .build());
    }

    public void addUsage(ChatUsage usage) {
        if (usage == null) return;
        this.totalUsage = ChatUsage.builder()
                .promptTokens(totalUsage.getPromptTokens() + usage.getPromptTokens())
                .completionTokens(totalUsage.getCompletionTokens() + usage.getCompletionTokens())
                .totalTokens(totalUsage.getTotalTokens() + usage.getTotalTokens())
                .build();
    }

    public boolean hasNextRound() {
        return currentRound < maxRounds;
    }

    public void clearPendingToolCalls() {
        this.pendingToolCalls = null;
    }
}
