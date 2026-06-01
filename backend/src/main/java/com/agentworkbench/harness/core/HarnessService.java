package com.agentworkbench.harness.core;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentTool;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentToolMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.llm.LlmModelConfig;
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

import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Service
@RequiredArgsConstructor
public class HarnessService {

    private final AgentLoop agentLoop;
    private final ToolRegistry toolRegistry;
    private final SkillLoader skillLoader;
    private final SessionMapper sessionMapper;
    private final AgentMapper agentMapper;
    private final AgentToolMapper agentToolMapper;
    private final ToolEntityMapper toolEntityMapper;
    private final LlmModelMapper llmModelMapper;
    private final MessageMapper messageMapper;
    private final SessionService sessionService;
    private final ObjectMapper objectMapper;
    private final ContextManager contextManager;
    private final CompactionConfig compactionConfig;

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
        executeFromEvent(sessionId, eventId, listener, null);
    }

    public void executeFromEvent(Long sessionId, String eventId, AgentEventListener listener,
                                  AtomicBoolean cancelFlag) {
        String userContent = eventContentStore.getIfPresent(eventId);
        if (userContent != null) {
            eventContentStore.invalidate(eventId);
        }
        execute(sessionId, userContent, listener, cancelFlag);
    }

    public void execute(Long sessionId, String userContent, AgentEventListener listener) {
        execute(sessionId, userContent, listener, null);
    }

    public void execute(Long sessionId, String userContent, AgentEventListener listener,
                         AtomicBoolean cancelFlag) {
        AgentExecutionContext context = buildContext(sessionId);

        // User message is already persisted by SessionController before streaming starts.

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
        if (cancelFlag != null) {
            agentLoop.removeCancelFlag(sessionId);
        }
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
        context.setCurrentTimestamp(java.time.ZonedDateTime.now()
                .format(java.time.format.DateTimeFormatter.ISO_ZONED_DATE_TIME));
        context.setSessionId(sessionId);
        context.setUserId(session.getUserId());
        context.setAgentId(agent.getId());
        context.setSystemPrompt(agent.getSystemPrompt());
        context.setAgentName(agent.getName());
        context.setMaxRounds(resolveMaxRounds(agent.getMaxRounds()));
        context.setExecutionMode(session.getExecutionMode() != null ? session.getExecutionMode() : "CLOUD");
        context.setWorkspace(session.getWorkspace());
        context.setModelConfig(LlmModelConfig.builder()
                .id(llmModel.getId())
                .name(llmModel.getName())
                .provider(llmModel.getProvider())
                .baseUrl(llmModel.getBaseUrl())
                .apiKey(llmModel.getApiKey())
                .modelId(llmModel.getModelId())
                .maxTokens(llmModel.getMaxTokens())
                .contextWindowTokens(llmModel.getContextWindowTokens())
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

        // 5.5. Session compaction — compress old history if needed
        CompactionConfig effectiveConfig = resolveCompactionConfig(agent);
        context.setCompactionConfig(effectiveConfig);
        if (effectiveConfig.isEnabled() && !context.getMessages().isEmpty()) {
            // Extract the latest user message as context for compaction
            String currentUserQuestion = null;
            for (int i = context.getMessages().size() - 1; i >= 0; i--) {
                if ("user".equals(context.getMessages().get(i).getRole())) {
                    currentUserQuestion = context.getMessages().get(i).getContent();
                    break;
                }
            }
            try {
                var result = contextManager.compactSession(
                        sessionId, context.getMessages(), context.getModelConfig(),
                        effectiveConfig, currentUserQuestion);
                if (result != null) {
                    context.getMessages().clear();
                    context.getMessages().addAll(result.compactedMessages());
                    context.setSessionSummary(result.summaryText());
                    log.info("Session compaction applied: {} messages compacted, ~{} tokens saved",
                            result.compactedCount(), result.savedTokens());
                }
            } catch (Exception e) {
                log.warn("Session compaction failed, falling back to full history", e);
            }
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

        return context;
    }

    /**
     * Resolve agent max LLM rounds.
     * 0 or null = unlimited (capped for safety); values &lt; 2 are bumped to 2 so a tool call
     * can be followed by at least one synthesis round.
     */
    static int resolveMaxRounds(Integer configured) {
        int maxRounds = configured != null ? configured : 30;
        if (maxRounds <= 0) {
            return 100;
        }
        return Math.max(maxRounds, 2);
    }

    /**
     * 解析 Agent 级压缩配置，未配置时使用全局默认值。
     * 通过 agent.configJson 中的 "compaction" 节覆盖。
     */
    private CompactionConfig resolveCompactionConfig(Agent agent) {
        if (agent.getConfigJson() == null || agent.getConfigJson().isBlank()) {
            return compactionConfig;
        }
        try {
            var node = objectMapper.readTree(agent.getConfigJson());
            var compactionNode = node.get("compaction");
            if (compactionNode == null) {
                return compactionConfig;
            }
            // Merge agent-level overrides with global defaults
            CompactionConfig merged = new CompactionConfig();
            // Copy global defaults first
            merged.setEnabled(compactionConfig.isEnabled());
            merged.setContextWindowTokens(compactionConfig.getContextWindowTokens());
            merged.setTriggerRatio(compactionConfig.getTriggerRatio());
            merged.setRecentTurns(compactionConfig.getRecentTurns());
            merged.setMinCompactMessageCount(compactionConfig.getMinCompactMessageCount());
            merged.setMinNewMessageCount(compactionConfig.getMinNewMessageCount());
            merged.setMaxCompactionBatchMessages(compactionConfig.getMaxCompactionBatchMessages());
            merged.setMaxRoundsPerRequest(compactionConfig.getMaxRoundsPerRequest());
            merged.setLoopEnabled(compactionConfig.isLoopEnabled());
            merged.setLoopTriggerTokens(compactionConfig.getLoopTriggerTokens());
            merged.setLoopRecentToolRounds(compactionConfig.getLoopRecentToolRounds());
            // Apply agent overrides
            if (compactionNode.has("enabled")) merged.setEnabled(compactionNode.get("enabled").asBoolean());
            if (compactionNode.has("contextWindowTokens")) merged.setContextWindowTokens(compactionNode.get("contextWindowTokens").asInt());
            if (compactionNode.has("triggerRatio")) merged.setTriggerRatio(compactionNode.get("triggerRatio").asDouble());
            if (compactionNode.has("recentTurns")) merged.setRecentTurns(compactionNode.get("recentTurns").asInt());
            if (compactionNode.has("minCompactMessageCount")) merged.setMinCompactMessageCount(compactionNode.get("minCompactMessageCount").asInt());
            if (compactionNode.has("minNewMessageCount")) merged.setMinNewMessageCount(compactionNode.get("minNewMessageCount").asInt());
            if (compactionNode.has("maxCompactionBatchMessages")) merged.setMaxCompactionBatchMessages(compactionNode.get("maxCompactionBatchMessages").asInt());
            if (compactionNode.has("maxRoundsPerRequest")) merged.setMaxRoundsPerRequest(compactionNode.get("maxRoundsPerRequest").asInt());
            if (compactionNode.has("loopEnabled")) merged.setLoopEnabled(compactionNode.get("loopEnabled").asBoolean());
            if (compactionNode.has("loopTriggerTokens")) merged.setLoopTriggerTokens(compactionNode.get("loopTriggerTokens").asInt());
            if (compactionNode.has("loopRecentToolRounds")) merged.setLoopRecentToolRounds(compactionNode.get("loopRecentToolRounds").asInt());
            return merged;
        } catch (Exception e) {
            log.warn("Failed to parse agent compaction config, using defaults", e);
            return compactionConfig;
        }
    }
}
