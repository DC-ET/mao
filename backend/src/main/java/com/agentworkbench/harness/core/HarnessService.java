package com.agentworkbench.harness.core;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.skill.SkillLoader;
import com.agentworkbench.harness.skill.SkillSyncService;
import com.agentworkbench.harness.tool.ToolRegistry;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.entity.FileChange;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.FileChangeMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Service
@RequiredArgsConstructor
public class HarnessService {

    private final AgentLoop agentLoop;
    private final ToolRegistry toolRegistry;
    private final SkillLoader skillLoader;
    private final SkillSyncService skillSyncService;
    private final SessionMapper sessionMapper;
    private final AgentMapper agentMapper;
    private final LlmModelMapper llmModelMapper;
    private final FileChangeMapper fileChangeMapper;
    private final SessionService sessionService;
    private final ObjectMapper objectMapper;
    private final ContextManager contextManager;
    private final CompactionConfig compactionConfig;
    private final EnvironmentInfoProvider environmentInfoProvider;

    public String prepareMessage(Long sessionId, Object userContent) {
        return java.util.UUID.randomUUID().toString();
    }

    public void executeFromEvent(Long sessionId, String eventId, AgentEventListener listener) {
        executeFromEvent(sessionId, eventId, listener, null);
    }

    public void executeFromEvent(Long sessionId, String eventId, AgentEventListener listener,
                                  AtomicBoolean cancelFlag) {
        // userContent is already persisted by the caller (StreamingWsHandler);
        // pass null to execute() since it loads messages from DB in buildContext().
        execute(sessionId, null, listener, cancelFlag);
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
            public void onSaveAssistantMessage(String content, String thinkingContent, List<ChatRequest.ToolCall> toolCalls, ChatUsage usage) {
                onSaveAssistantMessage(content, thinkingContent, toolCalls, java.util.Map.of(), usage);
            }

            @Override
            public void onSaveAssistantMessage(String content, String thinkingContent,
                                                List<ChatRequest.ToolCall> toolCalls,
                                                Map<String, String> toolResults, ChatUsage usage) {
                String toolCallsJson = null;
                if (toolCalls != null && !toolCalls.isEmpty()) {
                    try {
                        toolCallsJson = objectMapper.writeValueAsString(toolCalls);
                        log.debug("Persisting toolCalls JSON (first 500 chars): {}",
                                toolCallsJson.substring(0, Math.min(500, toolCallsJson.length())));
                    } catch (JsonProcessingException e) {
                        log.warn("Failed to serialize tool calls", e);
                    }
                }
                int tokenCount = usage != null ? usage.getTotalTokens() : 0;
                Long modelId = context.getModelConfig() != null ? context.getModelConfig().getId() : null;
                Message savedMsg = sessionService.saveMessage(sessionId, "ASSISTANT", content, thinkingContent, null, toolCallsJson, tokenCount, modelId);

                // Save file change records
                if (toolCalls != null && !toolCalls.isEmpty() && !toolResults.isEmpty()) {
                    saveFileChanges(savedMsg.getId(), sessionId, toolCalls, toolResults);
                }
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content) {
                sessionService.saveMessage(sessionId, "TOOL", content, null, toolCallId, null, 0, null);
            }
        };

        agentLoop.execute(context, listener, persistenceCallback);
        if (cancelFlag != null) {
            agentLoop.removeCancelFlag(sessionId);
        }
    }

    public AgentExecutionContext buildContext(Long sessionId) {
        // 清理上次中断遗留的不完整 tool_calls 消息，防止 LLM API 400
        sessionService.cleanupIncompleteTail(sessionId);

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

        // 3. Load model config — prefer session-level modelId, fallback to default
        LlmModel llmModel = resolveModel(session.getModelId());
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
        context.setMaxRounds(resolveMaxRounds(null));
        context.setExecutionMode(session.getExecutionMode() != null ? session.getExecutionMode() : "CLOUD");
        context.setPermissionLevel(session.getPermissionLevel());
        context.setWorkspace(session.getWorkspace());
        var environmentInfo = environmentInfoProvider.fromSessionOrDetect(session);
        context.setIsGit(environmentInfo.isGit());
        context.setPlatform(environmentInfo.platform());
        context.setShellPath(environmentInfo.shell());
        context.setOsVersion(environmentInfo.osVersion());
        context.setModelConfig(LlmModelConfig.builder()
                .id(llmModel.getId())
                .name(llmModel.getName())
                .provider(llmModel.getProvider())
                .baseUrl(llmModel.getBaseUrl())
                .apiKey(llmModel.getApiKey())
                .modelId(llmModel.getModelId())
                .contextWindowTokens(llmModel.getContextWindowTokens())
                .build());

        // 5. Load message history (normalize tool/assistant ordering for legacy rows)
        List<Message> history = MessageHistoryNormalizer.normalizeEntities(
                sessionService.getMessages(sessionId), objectMapper);
        for (Message msg : history) {
            Object parsedContent = parseContent(msg.getContent());
            var msgBuilder = ChatRequest.Message.builder()
                    .role(msg.getRole().toLowerCase())
                    .content(parsedContent);
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
                    currentUserQuestion = TokenEstimator.contentToString(context.getMessages().get(i).getContent());
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

        // 6. All built-in tools are available to every agent
        context.setTools(toolRegistry.getAllTools());

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
        // Merge system skills + user skills (user skills take priority on name conflict)
        List<String> baseSkillNames = agentSkillNames != null ? agentSkillNames : skillLoader.getAllNames();
        List<String> userSkillNames = skillSyncService.getUserSkillNames(session.getUserId());
        List<String> mergedSkillNames = new java.util.ArrayList<>(baseSkillNames);
        for (String userSkill : userSkillNames) {
            if (!mergedSkillNames.contains(userSkill)) {
                mergedSkillNames.add(userSkill);
            }
        }
        context.setAvailableSkillNames(mergedSkillNames);

        // Build merged skill document lookup (name → doc) for PromptEngine
        java.util.Map<String, com.agentworkbench.harness.skill.SkillDocument> skillDocMap = new java.util.LinkedHashMap<>();
        for (var doc : skillLoader.getAllDocuments()) {
            skillDocMap.put(doc.getName(), doc);
        }
        // User skills override system skills on name conflict
        for (var doc : skillSyncService.getUserSkillDocuments(session.getUserId())) {
            skillDocMap.put(doc.getName(), doc);
        }
        context.setAvailableSkillDocs(skillDocMap);

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
     * Parse content from DB: JSON array → List<ContentPart>, otherwise plain String.
     */
    private Object parseContent(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
            try {
                return objectMapper.readValue(trimmed,
                        new com.fasterxml.jackson.core.type.TypeReference<List<ChatRequest.ContentPart>>() {});
            } catch (Exception e) {
                return raw;  // fallback to plain text
            }
        }
        return raw;
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

    /**
     * Save file change records from tool results.
     * Merges changes for the same file path within one assistant message.
     */
    private void saveFileChanges(Long messageId, Long sessionId,
                                  List<ChatRequest.ToolCall> toolCalls,
                                  Map<String, String> toolResults) {
        Map<String, FileChange> merged = new LinkedHashMap<>();
        log.info("[FileChange] saveFileChanges called: messageId={}, sessionId={}, toolCallCount={}, toolResultKeys={}",
                messageId, sessionId, toolCalls.size(), toolResults.keySet());

        for (ChatRequest.ToolCall tc : toolCalls) {
            String toolName = tc.getFunction().getName();
            if (!"write_file".equals(toolName) && !"edit_file".equals(toolName)) continue;

            String result = toolResults.get(tc.getId());
            log.info("[FileChange] Processing tool={}, tcId={}, resultPresent={}, resultPreview={}",
                    toolName, tc.getId(), result != null, result != null ? result.substring(0, Math.min(200, result.length())) : "null");
            if (result == null) continue;

            try {
                JsonNode resultNode = objectMapper.readTree(result);
                boolean hasFileChange = resultNode.has("file_change");
                boolean success = resultNode.path("success").asBoolean();
                log.info("[FileChange] Parsed result: hasFileChange={}, success={}", hasFileChange, success);
                if (!hasFileChange || !success) continue;
                JsonNode fc = resultNode.get("file_change");
                String path = fc.get("path").asText();

                FileChange existing = merged.get(path);
                if (existing != null) {
                    existing.setLinesAdded(existing.getLinesAdded() + fc.get("lines_added").asInt());
                    existing.setLinesDeleted(existing.getLinesDeleted() + fc.get("lines_deleted").asInt());
                    if ("CREATED".equals(fc.get("type").asText())) {
                        existing.setChangeType("CREATED");
                    }
                } else {
                    FileChange change = new FileChange();
                    change.setMessageId(messageId);
                    change.setSessionId(sessionId);
                    change.setFilePath(path);
                    change.setChangeType(fc.get("type").asText());
                    change.setLinesAdded(fc.get("lines_added").asInt());
                    change.setLinesDeleted(fc.get("lines_deleted").asInt());
                    merged.put(path, change);
                }
            } catch (Exception e) {
                log.debug("Failed to parse file_change from tool result for tool {}", toolName, e);
            }
        }

        for (FileChange fc : merged.values()) {
            try {
                fileChangeMapper.insert(fc);
            } catch (Exception e) {
                log.warn("Failed to save file change record for {}", fc.getFilePath(), e);
            }
        }
    }

    /**
     * Resolve model: prefer explicit modelId, fallback to default model.
     */
    public LlmModel resolveModel(Long modelId) {
        if (modelId != null) {
            return llmModelMapper.selectById(modelId);
        }
        return llmModelMapper.selectOne(
                new QueryWrapper<LlmModel>().eq("is_default", 1).eq("status", 1));
    }
}
