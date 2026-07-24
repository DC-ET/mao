package cn.etarch.mao.harness.core;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.service.AgentExperienceService;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.harness.skill.LocalSkillRef;
import cn.etarch.mao.harness.skill.LocalSkillRegistry;
import cn.etarch.mao.harness.skill.SkillLoader;
import cn.etarch.mao.harness.skill.SkillSyncService;
import cn.etarch.mao.harness.tool.FileChangeDiffUtil;
import cn.etarch.mao.harness.tool.ToolRegistry;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.entity.FileChange;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.FileChangeMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
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
    private final LocalSkillRegistry localSkillRegistry;
    private final LocalAgentsMdRegistry localAgentsMdRegistry;
    private final SessionMapper sessionMapper;
    private final AgentMapper agentMapper;
    private final AgentExperienceService experienceService;
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
                onSaveToolMessage(toolCallId, content, null);
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content, String metadataJson) {
                sessionService.saveMessage(sessionId, "TOOL", content, null, toolCallId, null, 0, null, metadataJson);
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
        String executionMode = session.getExecutionMode() != null ? session.getExecutionMode() : "CLOUD";

        // CLOUD：同步 Skills 到会话 runtime，并注册 PathSandbox allowedRoots。
        // 微信等非 WebSocket 入口也会走这里；桌面 WS 路径可能已同步过，重复调用对未变更 Skill 为 no-op。
        if ("CLOUD".equalsIgnoreCase(executionMode)) {
            try {
                skillSyncService.syncToSession(agent, session.getUserId(), sessionId);
            } catch (Exception e) {
                log.warn("Skill sync to session runtime failed for session {}: {}", sessionId, e.getMessage());
            }
        }

        AgentExecutionContext context = new AgentExecutionContext();
        context.setCurrentTimestamp(java.time.ZonedDateTime.now()
                .format(java.time.format.DateTimeFormatter.ISO_ZONED_DATE_TIME));
        context.setSessionId(sessionId);
        context.setUserId(session.getUserId());
        context.setAgentId(agent.getId());
        context.setProjectKey(session.getProjectKey());
        context.setSystemPrompt(agent.getSystemPrompt());
        context.setExperiences(experienceService.listEnabledContents(agent.getId()));
        context.setAgentName(agent.getName());
        context.setMaxRounds(resolveMaxRounds(null));
        context.setExecutionMode(executionMode);
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
                .supportsVision(llmModel.getSupportsVision() != null && llmModel.getSupportsVision() == 1)
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
        context.getToolAttachments().putAll(ToolAttachmentLoader.loadAllFromMessages(history, objectMapper));

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
        List<String> userSkillNames = skillSyncService.getUserSkillNames(session.getUserId());

        // syncable = 服务端确实有文件、能打进 LOCAL sync zip / 拷进 CLOUD runtime 的技能。
        // 注意：不能仅凭 agent.skillNames 里的名字判定为已同步——配置里可能有名无文件。
        java.util.Set<String> syncableNames = new java.util.HashSet<>(userSkillNames);
        List<String> mergedSkillNames = new java.util.ArrayList<>();
        if (agentSkillNames != null) {
            for (String name : agentSkillNames) {
                if (skillLoader.hasSkill(name)) {
                    syncableNames.add(name);
                    mergedSkillNames.add(name);
                }
            }
        } else {
            for (String name : skillLoader.getAllNames()) {
                syncableNames.add(name);
                mergedSkillNames.add(name);
            }
        }
        for (String userSkill : userSkillNames) {
            if (!mergedSkillNames.contains(userSkill)) {
                mergedSkillNames.add(userSkill);
            }
        }

        // LOCAL mode: merge in desktop client's locally-scanned, not-yet-uploaded skills.
        // These are usable for this LOCAL task only (read directly from the desktop
        // machine at ~/.agents/skills); using them in a CLOUD task still requires upload.
        if ("LOCAL".equalsIgnoreCase(context.getExecutionMode())) {
            mergeLocalUnsyncedSkills(mergedSkillNames, syncableNames, localSkillRegistry.get(sessionId), context);
            // 获取桌面端上报的 AGENTS.md 内容
            String agentsMdContent = localAgentsMdRegistry.get(sessionId);
            context.setAgentsMdContent(agentsMdContent);
        }
        context.setAvailableSkillNames(mergedSkillNames);

        // Build merged skill document lookup (name → doc) for PromptEngine
        java.util.Map<String, cn.etarch.mao.harness.skill.SkillDocument> skillDocMap = new java.util.LinkedHashMap<>();
        for (var doc : skillLoader.getAllDocuments()) {
            skillDocMap.put(doc.getName(), doc);
        }
        // User skills override system skills on name conflict
        for (var doc : skillSyncService.getUserSkillDocuments(session.getUserId())) {
            skillDocMap.put(doc.getName(), doc);
        }
        // Local unsynced skills only fill in when there's no existing doc for the name
        for (LocalSkillRef ref : context.getLocalUnsyncedSkills()) {
            skillDocMap.computeIfAbsent(ref.getName(), name -> {
                var doc = new cn.etarch.mao.harness.skill.SkillDocument();
                doc.setName(ref.getName());
                doc.setDescription(ref.getDescription());
                return doc;
            });
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
     * 合并桌面端上报的本地技能。仅当服务端无法同步同名技能时标为 localUnsynced，
     * 使 PromptEngine 注入 {@code ~/.agents/skills/...} 而非缺失的 runtime 副本路径。
     * <p>
     * 旧逻辑用 {@code mergedSkillNames.contains(name)} 判断，会把 agent.skillNames
     * 中「有名无文件」的条目误判为已同步，导致 Agent 去读
     * {@code ~/.mao/runtime/{sessionId}/skills/{name}/SKILL.md} 而文件从未被解压。
     */
    static void mergeLocalUnsyncedSkills(List<String> mergedSkillNames,
                                         java.util.Set<String> syncableNames,
                                         List<LocalSkillRef> localSkills,
                                         AgentExecutionContext context) {
        if (localSkills == null || localSkills.isEmpty()) {
            return;
        }
        List<LocalSkillRef> unsynced = new java.util.ArrayList<>();
        for (LocalSkillRef ref : localSkills) {
            if (ref == null || ref.getName() == null || ref.getName().isBlank()) {
                continue;
            }
            if (!syncableNames.contains(ref.getName())) {
                if (!mergedSkillNames.contains(ref.getName())) {
                    mergedSkillNames.add(ref.getName());
                }
                unsynced.add(ref);
            }
        }
        context.setLocalUnsyncedSkills(unsynced);
    }

    /**
     * Parse content from DB: JSON array → List<ContentPart>, otherwise plain String.
     */
    private Object parseContent(String raw) {
        if (raw == null) return "";
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
                JsonNode diff = resultNode.get(FileChangeDiffUtil.PRIVATE_DIFF_FIELD);

                FileChange existing = merged.get(path);
                if (existing != null) {
                    existing.setLinesAdded(existing.getLinesAdded() + fc.get("lines_added").asInt());
                    existing.setLinesDeleted(existing.getLinesDeleted() + fc.get("lines_deleted").asInt());
                    if ("CREATED".equals(fc.get("type").asText())) {
                        existing.setChangeType("CREATED");
                    }
                    mergeDiffPayload(existing, diff);
                } else {
                    FileChange change = new FileChange();
                    change.setMessageId(messageId);
                    change.setSessionId(sessionId);
                    change.setFilePath(path);
                    change.setChangeType(fc.get("type").asText());
                    change.setLinesAdded(fc.get("lines_added").asInt());
                    change.setLinesDeleted(fc.get("lines_deleted").asInt());
                    applyDiffPayload(change, diff);
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

    private void applyDiffPayload(FileChange change, JsonNode diff) {
        if (diff == null || !diff.isObject()) {
            return;
        }
        String mode = textOrNull(diff, "diff_mode");
        change.setDiffMode(mode);
        change.setBeforeContent(textOrNull(diff, "before_content"));
        change.setAfterContent(textOrNull(diff, "after_content"));
        change.setPatchContent(textOrNull(diff, "patch_content"));
        change.setPatchTruncated(booleanOrFalse(diff, "patch_truncated"));
        change.setDiffUnavailableReason(textOrNull(diff, "diff_unavailable_reason"));
    }

    private void mergeDiffPayload(FileChange existing, JsonNode diff) {
        if (diff == null || !diff.isObject()) {
            return;
        }
        String mode = textOrNull(diff, "diff_mode");
        if (mode == null) {
            return;
        }

        if (existing.getDiffMode() == null) {
            applyDiffPayload(existing, diff);
            return;
        }

        if ("SNAPSHOT".equals(existing.getDiffMode()) && "SNAPSHOT".equals(mode)) {
            String after = textOrNull(diff, "after_content");
            if (after != null) {
                existing.setAfterContent(after);
            }
            existing.setPatchTruncated(Boolean.TRUE.equals(existing.getPatchTruncated())
                    || booleanOrFalse(diff, "patch_truncated"));
            return;
        }

        if ("PATCH".equals(existing.getDiffMode()) || "PATCH".equals(mode)) {
            existing.setDiffMode("PATCH");
            String patch = textOrNull(diff, "patch_content");
            if (patch == null && "SNAPSHOT".equals(mode)) {
                patch = "[snapshot diff omitted after patch-mode aggregation]\n";
            }
            String current = existing.getPatchContent();
            if (current == null && existing.getBeforeContent() != null && existing.getAfterContent() != null) {
                current = "[snapshot diff omitted before patch-mode aggregation]\n";
            }
            existing.setPatchContent(joinPatch(current, patch));
            existing.setBeforeContent(null);
            existing.setAfterContent(null);
            existing.setPatchTruncated(Boolean.TRUE.equals(existing.getPatchTruncated())
                    || booleanOrFalse(diff, "patch_truncated"));
            return;
        }

        if ("UNSUPPORTED".equals(mode)) {
            existing.setDiffMode("UNSUPPORTED");
            existing.setBeforeContent(null);
            existing.setAfterContent(null);
            existing.setPatchContent(null);
            existing.setPatchTruncated(false);
            existing.setDiffUnavailableReason(textOrNull(diff, "diff_unavailable_reason"));
        }
    }

    private String joinPatch(String current, String patch) {
        if (current == null || current.isBlank()) {
            return patch;
        }
        if (patch == null || patch.isBlank()) {
            return current;
        }
        return current + "\n" + patch;
    }

    private String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private boolean booleanOrFalse(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && !value.isNull() && value.asBoolean(false);
    }

    /**
     * 执行边路任务的首条消息。与主任务并行，使用独立的子会话。
     * 首条消息支持注入主任务上下文摘要（仅一次），后续消息走标准 executeFromEvent() 流程。
     *
     * @param parentSessionId 主任务会话 ID
     * @param sideSessionId   边路任务子会话 ID
     * @param inheritContext  是否注入主任务上下文摘要
     * @param listener        边路任务的事件监听器
     * @param cancelFlag      取消标志
     */
    public void executeSideFirstMessage(Long parentSessionId,
                                         Long sideSessionId,
                                         boolean inheritContext,
                                         AgentEventListener listener,
                                         AtomicBoolean cancelFlag) {
        // 1. 构建边路任务上下文（复用 buildContext）
        AgentExecutionContext context = buildContext(sideSessionId);

        // 2. 如果选择继承主任务上下文，注入摘要到 system prompt（仅首条消息）
        if (inheritContext) {
            String contextSummary = generateContextSummary(parentSessionId);
            if (contextSummary != null && !contextSummary.isBlank()) {
                String enrichedSystemPrompt = context.getSystemPrompt()
                        + "\n\n<主任务背景摘要>\n"
                        + contextSummary
                        + "\n</主任务背景摘要>\n"
                        + "以上是主任务的最近对话摘要，本次边路任务的结果不需要反馈到主任务。";
                context.setSystemPrompt(enrichedSystemPrompt);
            }
        }

        // 3. 持久化回调：写入边路任务子会话
        AgentLoop.MessagePersistenceCallback persistenceCallback =
            new AgentLoop.MessagePersistenceCallback() {
                @Override
                public void onSaveAssistantMessage(String content, String thinkingContent,
                                                    List<ChatRequest.ToolCall> toolCalls,
                                                    ChatUsage usage) {
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
                        } catch (JsonProcessingException e) {
                            log.warn("Failed to serialize tool calls for side task", e);
                        }
                    }
                    int tokenCount = usage != null ? usage.getTotalTokens() : 0;
                    Long modelId = context.getModelConfig() != null
                            ? context.getModelConfig().getId() : null;
                    Message savedMsg = sessionService.saveMessage(sideSessionId, "ASSISTANT",
                            content, thinkingContent, null, toolCallsJson,
                            tokenCount, modelId);

                    // Save file change records
                    if (toolCalls != null && !toolCalls.isEmpty() && !toolResults.isEmpty()) {
                        saveFileChanges(savedMsg.getId(), sideSessionId, toolCalls, toolResults);
                    }
                }

                @Override
                public void onSaveToolMessage(String toolCallId, String content) {
                    onSaveToolMessage(toolCallId, content, null);
                }

                @Override
                public void onSaveToolMessage(String toolCallId, String content, String metadataJson) {
                    sessionService.saveMessage(sideSessionId, "TOOL",
                            content, null, toolCallId, null, 0, null, metadataJson);
                }
            };

        // 4. 执行 Agent Loop
        agentLoop.execute(context, listener, persistenceCallback);
        if (cancelFlag != null) {
            agentLoop.removeCancelFlag(sideSessionId);
        }
    }

    /**
     * 生成主任务上下文摘要。
     * 取最近若干条消息的摘要，帮助边路 Agent 理解主任务背景。
     */
    private String generateContextSummary(Long parentSessionId) {
        try {
            List<Message> messages = sessionService.getMessages(parentSessionId);
            if (messages.isEmpty()) return null;

            int fromIndex = Math.max(0, messages.size() - 10);
            List<Message> recentMessages = messages.subList(fromIndex, messages.size());

            StringBuilder sb = new StringBuilder();
            sb.append("以下是主任务最近的对话摘要：\n\n");
            for (Message msg : recentMessages) {
                String role = msg.getRole();
                String content = msg.getContent();
                if (content != null && !content.isBlank()) {
                    String truncated = content.length() > 300
                            ? content.substring(0, 300) + "..."
                            : content;
                    sb.append("[").append(role).append("]: ").append(truncated).append("\n");
                }
            }
            return sb.toString();
        } catch (Exception e) {
            log.warn("Failed to generate context summary for side task", e);
            return null;
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
