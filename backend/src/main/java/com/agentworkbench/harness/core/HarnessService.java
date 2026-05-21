package com.agentworkbench.harness.core;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentMcpConfig;
import com.agentworkbench.agent.entity.AgentTool;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentMcpConfigMapper;
import com.agentworkbench.agent.mapper.AgentToolMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.mcp.McpTool;
import com.agentworkbench.harness.mcp.McpToolRegistry;
import com.agentworkbench.harness.skill.SkillLoader;
import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.harness.tool.ToolRegistry;
import com.agentworkbench.tool.entity.ToolEntity;
import com.agentworkbench.tool.mapper.ToolEntityMapper;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.MessageMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
@RequiredArgsConstructor
public class HarnessService {

    private final AgentLoop agentLoop;
    private final ToolRegistry toolRegistry;
    private final SkillLoader skillLoader;
    private final McpToolRegistry mcpToolRegistry;
    private final SessionMapper sessionMapper;
    private final AgentMapper agentMapper;
    private final AgentToolMapper agentToolMapper;
    private final AgentMcpConfigMapper agentMcpConfigMapper;
    private final ToolEntityMapper toolEntityMapper;
    private final LlmModelMapper llmModelMapper;
    private final MessageMapper messageMapper;
    private final SessionService sessionService;
    private final ObjectMapper objectMapper;

    // In-memory event content store with TTL
    private final Cache<String, String> eventContentStore = Caffeine.newBuilder()
            .expireAfterWrite(10, TimeUnit.MINUTES)
            .maximumSize(1000)
            .build();

    public String prepareMessage(Long sessionId, String userContent) {
        String eventId = java.util.UUID.randomUUID().toString();
        eventContentStore.put(eventId, userContent);
        return eventId;
    }

    public void executeFromEvent(Long sessionId, String eventId, AgentEventListener listener) {
        String userContent = eventContentStore.getIfPresent(eventId);
        if (userContent != null) {
            eventContentStore.invalidate(eventId);
        }
        execute(sessionId, userContent, listener);
    }

    public void execute(Long sessionId, String userContent, AgentEventListener listener) {
        AgentExecutionContext context = buildContext(sessionId);

        if (userContent != null && !userContent.isEmpty()) {
            context.addUserMessage(userContent);
        }

        AgentLoop.MessagePersistenceCallback persistenceCallback = new AgentLoop.MessagePersistenceCallback() {
            @Override
            public void onSaveAssistantMessage(String content, List<ChatRequest.ToolCall> toolCalls, ChatUsage usage) {
                String toolCallsJson = null;
                if (toolCalls != null && !toolCalls.isEmpty()) {
                    try {
                        toolCallsJson = objectMapper.writeValueAsString(toolCalls);
                    } catch (JsonProcessingException e) {
                        log.warn("Failed to serialize tool calls", e);
                    }
                }
                int tokenCount = usage != null ? usage.getTotalTokens() : 0;
                Long modelId = context.getModelConfig() != null ? context.getModelConfig().getId() : null;
                sessionService.saveMessage(sessionId, "ASSISTANT", content, null, toolCallsJson, tokenCount, modelId);
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content) {
                sessionService.saveMessage(sessionId, "TOOL", content, toolCallId, null, 0, null);
            }
        };

        agentLoop.execute(context, listener, persistenceCallback);
    }

    private AgentExecutionContext buildContext(Long sessionId) {
        // 1. Load session
        Session session = sessionMapper.selectById(sessionId);
        if (session == null) {
            throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
        }

        // 2. Load agent
        Agent agent = agentMapper.selectById(session.getAgentId());
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        // 3. Load model config
        LlmModel llmModel = llmModelMapper.selectById(agent.getModelId());
        if (llmModel == null) {
            throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
        }

        // 4. Build context
        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(sessionId);
        context.setUserId(session.getUserId());
        context.setAgentId(agent.getId());
        context.setSystemPrompt(agent.getSystemPrompt());
        context.setAgentName(agent.getName());
        context.setMaxRounds(agent.getMaxRounds() != null && agent.getMaxRounds() > 0 ? agent.getMaxRounds() : 10);
        context.setExecutionMode(session.getExecutionMode() != null ? session.getExecutionMode() : "CLOUD");
        context.setModelConfig(LlmModelConfig.builder()
                .id(llmModel.getId())
                .name(llmModel.getName())
                .provider(llmModel.getProvider())
                .baseUrl(llmModel.getBaseUrl())
                .apiKey(llmModel.getApiKey())
                .modelId(llmModel.getModelId())
                .maxTokens(llmModel.getMaxTokens())
                .temperatureMax(llmModel.getTemperatureMax() != null ? llmModel.getTemperatureMax().doubleValue() : null)
                .build());

        // 5. Load message history
        List<Message> history = messageMapper.selectList(
                new QueryWrapper<Message>()
                        .eq("session_id", sessionId)
                        .orderByAsc("created_at"));
        for (Message msg : history) {
            var msgBuilder = ChatRequest.Message.builder()
                    .role(msg.getRole().toLowerCase())
                    .content(msg.getContent());
            if (msg.getToolCallId() != null) {
                msgBuilder.toolCallId(msg.getToolCallId());
            }
            if (msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                try {
                    List<ChatRequest.ToolCall> toolCalls = objectMapper.readValue(
                            msg.getToolCalls(), new TypeReference<List<ChatRequest.ToolCall>>() {});
                    msgBuilder.toolCalls(toolCalls);
                } catch (JsonProcessingException e) {
                    log.warn("Failed to parse tool_calls for message {}", msg.getId(), e);
                }
            }
            context.getMessages().add(msgBuilder.build());
        }

        // 6. Load per-agent tools (fallback: all built-in tools if none configured)
        List<AgentTool> agentTools = agentToolMapper.selectList(
                new QueryWrapper<AgentTool>().eq("agent_id", agent.getId()));
        if (!agentTools.isEmpty()) {
            List<Long> toolIds = agentTools.stream().map(AgentTool::getToolId).toList();
            List<ToolEntity> toolEntities = toolEntityMapper.selectBatchIds(toolIds);
            List<String> toolNames = toolEntities.stream().map(ToolEntity::getName).toList();
            List<Tool> tools = toolRegistry.getToolsByNames(toolNames);
            context.setTools(tools);
        } else {
            context.setTools(toolRegistry.getAllTools());
        }

        // 7. Load available Skill names for this agent
        List<String> agentSkillNames = null;
        if (agent.getSkillNames() != null && !agent.getSkillNames().isEmpty()) {
            try {
                agentSkillNames = objectMapper.readValue(
                        agent.getSkillNames(), new com.fasterxml.jackson.core.type.TypeReference<List<String>>() {});
            } catch (Exception e) {
                log.warn("Failed to parse skillNames for agent {}: {}", agent.getId(), e.getMessage());
            }
        }
        context.setAvailableSkillNames(
                agentSkillNames != null ? agentSkillNames : skillLoader.getAllNames());

        // 8. Load MCP tools for this agent
        List<AgentMcpConfig> mcpConfigs = agentMcpConfigMapper.selectList(
                new QueryWrapper<AgentMcpConfig>()
                        .eq("agent_id", agent.getId())
                        .eq("status", 1));
        List<McpTool> mcpTools = new ArrayList<>();
        for (AgentMcpConfig config : mcpConfigs) {
            List<McpTool> discovered = mcpToolRegistry.discoverAndRegister(config.getServerUrl());
            mcpTools.addAll(discovered);
        }
        context.setMcpTools(mcpTools);

        return context;
    }
}
