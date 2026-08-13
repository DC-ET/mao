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
import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.harness.tool.ToolRegistry;
import cn.etarch.mao.harness.tool.WeixinChannelTool;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.entity.FileChange;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.FileChangeMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.weixin.service.WeixinSessionService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.JsonProcessingException;
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

    /** 微信通道屏蔽的工具：无交互式提问面板，避免 Agent 阻塞等待回答 */
    private static final String ASK_USER_QUESTIONS = "ask_user_questions";

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
    private final SessionCompactionService sessionCompactionService;
    private final SessionHistoryLoader sessionHistoryLoader;
    private final SessionCompactionOrchestrator sessionCompactionOrchestrator;
    private final PromptEngine promptEngine;
    private final ActiveContextCalculator activeContextCalculator;
    private final ObjectMapper objectMapper;
    private final CompactionConfig compactionConfig;
    private final EnvironmentInfoProvider environmentInfoProvider;
    private final cn.etarch.mao.harness.mcp.McpClientManager mcpClientManager;
    private final cn.etarch.mao.harness.mcp.local.McpSyncService mcpSyncService;

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
        AgentExecutionContext context = buildContext(sessionId, listener, cancelFlag);

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

    /**
     * 为指定会话创建消息持久化回调（主会话 / 边路 / 子智能体共用）。
     */
    public AgentLoop.MessagePersistenceCallback createPersistenceCallback(
            Long targetSessionId, AgentExecutionContext context) {
        return new AgentLoop.MessagePersistenceCallback() {
            @Override
            public void onSaveAssistantMessage(String content, String thinkingContent,
                                                List<ChatRequest.ToolCall> toolCalls, ChatUsage usage) {
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
                        log.warn("Failed to serialize tool calls for session {}", targetSessionId, e);
                    }
                }
                int tokenCount = usage != null ? usage.getTotalTokens() : 0;
                Long modelId = context.getModelConfig() != null ? context.getModelConfig().getId() : null;
                Message savedMsg = sessionService.saveMessage(targetSessionId, "ASSISTANT",
                        content, thinkingContent, null, toolCallsJson, tokenCount, modelId);
                if (toolCalls != null && !toolCalls.isEmpty() && toolResults != null && !toolResults.isEmpty()) {
                    saveFileChanges(savedMsg.getId(), targetSessionId, toolCalls, toolResults);
                }
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content) {
                onSaveToolMessage(toolCallId, content, null);
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content, String metadataJson) {
                sessionService.saveMessage(targetSessionId, "TOOL",
                        content, null, toolCallId, null, 0, null, metadataJson);
            }
        };
    }

    /**
     * 执行已构建好的上下文，并持久化中间轮次消息（供子智能体可见性使用）。
     */
    public void executePrepared(AgentExecutionContext context, AgentEventListener listener) {
        AgentLoop.MessagePersistenceCallback persistence =
                createPersistenceCallback(context.getSessionId(), context);
        agentLoop.execute(context, listener, persistence);
    }

    public AgentExecutionContext buildContext(Long sessionId) {
        return buildContext(sessionId, null, null);
    }

    private AgentExecutionContext buildContext(Long sessionId, AgentEventListener listener) {
        return buildContext(sessionId, listener, null);
    }

    private AgentExecutionContext buildContext(Long sessionId, AgentEventListener listener,
                                                AtomicBoolean cancelFlag) {
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
        context.setCancelFlag(cancelFlag);
        context.setCurrentTimestamp(java.time.LocalDate.now()
                .format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE));
        context.setSessionId(sessionId);
        context.setUserId(session.getUserId());
        context.setAgentId(agent.getId());
        context.setProjectKey(session.getProjectKey());
        context.setSystemPrompt(agent.getSystemPrompt());
        context.setExperiences(experienceService.listEnabledContents(agent.getId()));
        context.setAgentName(agent.getName());
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

        // 5. Resolve and validate the durable compaction boundary before loading history.
        CompactionConfig effectiveConfig = resolveCompactionConfig(agent);
        context.setCompactionConfig(effectiveConfig);
        SessionCompaction compactionRecord = sessionCompactionService.loadValidated(sessionId);
        long boundary = sessionCompactionService.boundaryOf(compactionRecord);
        String summary = compactionRecord != null ? compactionRecord.getSummaryText() : null;

        // A safe boundary is always at a completed tool round (assistant + all tool results).
        sessionService.cleanupIncompleteTailAfterId(sessionId, boundary);
        SessionHistoryLoader.HistorySnapshot history =
                sessionHistoryLoader.loadHistoryAfterBoundary(sessionId, boundary);
        sessionHistoryLoader.applyHistory(context, summary, history);

        // Load persisted prompt_tokens anchor for unified active-context calculation
        SessionService.ContextAnchor anchor = sessionService.loadContextAnchor(sessionId);
        context.setLastPromptTokens(anchor.lastPromptTokens());
        context.setContextAnchorMsgId(anchor.contextAnchorMsgId());

        // 6. All built-in tools are available to every agent; WeixinChannelTool 仅在微信通道会话注入。
        //    微信通道无交互式提问面板（ask_user_questions 依赖 WebSocket 客户端回答），故屏蔽该工具，
        //    避免 Agent 调用后阻塞等待用户回答直至超时。
        List<Tool> sessionTools = filterToolsForSession(toolRegistry.getAllTools(), session.getProjectKey());
        context.setTools(sessionTools);

        // 6.5 MCP 工具注入（按 Agent 关联的全局服务器 + 用户私有服务器，双模式）
        // 防御：mcpSyncService 为 null（非 Spring 装配的测试/入口）时整体跳过 MCP 注入，
        // 避免 NPE 被 catch 后以「加载失败」警告形式污染会话提示词。
        // 权限说明：mcp:read/mcp:write 权限维度已移除，所有登录用户均可在会话中使用 MCP 工具。
        java.util.List<String> mcpWarnings = new java.util.ArrayList<>();
        if (mcpSyncService != null) {
            try {
                java.util.List<cn.etarch.mao.harness.mcp.entity.McpServer> mcpServers =
                        mcpSyncService.loadAgentServers(agent, session.getUserId());
                if (!mcpServers.isEmpty()) {
                    if ("LOCAL".equalsIgnoreCase(executionMode)) {
                        // LOCAL 模式：使用桌面端已上报的工具清单（StreamingWsHandler 已同步等待完成）
                        java.util.List<cn.etarch.mao.harness.mcp.model.McpToolRef> localTools =
                                mcpSyncService.getLocalSessionTools(sessionId);
                        if (!localTools.isEmpty()) {
                            localTools.forEach(ref -> sessionTools.add(
                                    new cn.etarch.mao.harness.mcp.McpToolAdapter(ref, mcpClientManager)));
                        }
                    } else if (mcpClientManager != null) {
                        // CLOUD 模式：服务端直连，逐台连接拉取清单；单台失败降级
                        cn.etarch.mao.harness.mcp.local.McpSyncService.CloudConnectResult cloudResult =
                                mcpSyncService.connectForCloud(sessionId, mcpServers, mcpClientManager);
                        cloudResult.tools().forEach(ref -> sessionTools.add(
                                new cn.etarch.mao.harness.mcp.McpToolAdapter(ref, mcpClientManager)));
                        mcpWarnings.addAll(cloudResult.warnings());
                    } else {
                        log.warn("MCP client manager unavailable for session {}, skipping CLOUD MCP injection", sessionId);
                    }
                }
            } catch (Exception e) {
                log.warn("MCP tool injection failed for session {}: {}", sessionId, e.getMessage());
                mcpWarnings.add("MCP 工具加载失败：" + e.getMessage());
            }
        }
        context.setTools(sessionTools);

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

        // MCP 连接降级提示（仅当存在失败服务器时；messages 每轮由 applyHistory 重置，不会累积）
        if (!mcpWarnings.isEmpty()) {
            context.addSystemMessage("⚠ " + String.join("；", mcpWarnings)
                    + "。相关 MCP 工具不可用，请勿调用；如需恢复请检查服务器配置后新开会话。");
        }

        // 压缩检查必须发生在工具、MCP、技能和所有临时 system message 都准备完成之后，
        // 以确保压缩请求是即将发送的正常请求的严格前缀扩展。
        if (effectiveConfig.isEnabled() && !history.persistedMessages().isEmpty()) {
            ChatRequest normalRequest = buildNormalRequest(context);
            try {
                sessionCompactionOrchestrator.compact(sessionId, context, normalRequest, listener,
                        effectiveConfig, false, cancelFlag);
                // Orchestrator may reload a concurrent compaction result even when our CAS did not advance.
                context.setPreparedRequest(buildNormalRequest(context));
            } catch (CompactionService.CompactionContextOverflowException
                     | CompactionService.CompactionCancelledException
                     | SessionCompactionOrchestrator.CompactionStateReloadException e) {
                throw e;
            } catch (RuntimeException e) {
                // The durable boundary may already have advanced before a post-persist metric/anchor failure.
                // Rebuild from the current context instead of falling back to the stale pre-compaction snapshot.
                context.setPreparedRequest(buildNormalRequest(context));
                log.warn("Session compaction failed; continuing with a request rebuilt from current context", e);
            }
        } else {
            context.setPreparedRequest(buildNormalRequest(context));
        }

        return context;
    }

    private ChatRequest buildNormalRequest(AgentExecutionContext context) {
        return promptEngine.buildRequest(context);
    }

    /**
     * 按会话 projectKey 过滤内置工具集：
     * <ul>
     *   <li>微信通道会话（projectKey = weixin-bot）：保留 WeixinChannelTool，屏蔽 ask_user_questions
     *       （微信无交互式提问面板，调用会导致 Agent 阻塞等待直至超时）</li>
     *   <li>其他会话：移除 WeixinChannelTool（微信通道专属工具）</li>
     * </ul>
     */
    static List<Tool> filterToolsForSession(List<Tool> tools, String projectKey) {
        List<Tool> result = new java.util.ArrayList<>(tools);
        if (WeixinSessionService.PROJECT_KEY.equals(projectKey)) {
            result.removeIf(t -> ASK_USER_QUESTIONS.equals(t.getName()));
        } else {
            result.removeIf(t -> t instanceof WeixinChannelTool);
        }
        return result;
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
            merged.setMaxSummaryTokens(compactionConfig.getMaxSummaryTokens());
            merged.setLoopMidwayCompact(compactionConfig.isLoopMidwayCompact());
            // Apply agent overrides
            if (compactionNode.has("enabled")) merged.setEnabled(compactionNode.get("enabled").asBoolean());
            if (compactionNode.has("contextWindowTokens")) merged.setContextWindowTokens(compactionNode.get("contextWindowTokens").asInt());
            if (compactionNode.has("triggerRatio")) merged.setTriggerRatio(compactionNode.get("triggerRatio").asDouble());
            if (compactionNode.has("maxSummaryTokens")) merged.setMaxSummaryTokens(compactionNode.get("maxSummaryTokens").asInt());
            if (compactionNode.has("loopMidwayCompact")) merged.setLoopMidwayCompact(compactionNode.get("loopMidwayCompact").asBoolean());
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
        AgentExecutionContext context = buildContext(sideSessionId, listener);

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
