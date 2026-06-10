package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.tool.Tool;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

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
    private String permissionLevel;
    private String workspace;
    private Boolean isGit;
    private String platform;
    private String shellPath;
    private String osVersion;

    // 对话消息历史
    private List<ChatRequest.Message> messages = new ArrayList<>();

    // 可用工具
    private List<Tool> tools = new ArrayList<>();

    // 可用 Skill 知识文档名称列表（为空则加载全部）
    private List<String> availableSkillNames = new ArrayList<>();

    // 请求开始时间（单次请求内固定，保证 system prompt 前缀缓存命中）
    private String currentTimestamp;

    // 会话压缩摘要（跨轮次）
    private String sessionSummary;

    // 工作记忆摘要（当前请求内 loop 压缩）
    private String workingSummary;

    // 压缩配置（Agent 级覆盖，为 null 时使用全局默认）
    private CompactionConfig compactionConfig;

    // 执行状态
    private List<ChatRequest.ToolCall> pendingToolCalls;
    private ChatUsage totalUsage;
    private int currentRound = 0;

    // Loop 压缩计数
    private int loopToolRounds = 0;

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

    public void addUserMessage(List<ChatRequest.ContentPart> parts) {
        messages.add(ChatRequest.Message.builder()
                .role("user")
                .content(parts)
                .build());
    }

    public void addSystemMessage(String content) {
        messages.add(ChatRequest.Message.builder()
                .role("system")
                .content(content)
                .build());
    }

    public void addAssistantMessage(String content, List<ChatRequest.ToolCall> toolCalls) {
        boolean hasToolCalls = toolCalls != null && !toolCalls.isEmpty();
        String normalizedContent = content != null && !content.isEmpty() ? content : null;
        messages.add(ChatRequest.Message.builder()
                .role("assistant")
                .content(normalizedContent)
                .toolCalls(hasToolCalls ? toolCalls : null)
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
