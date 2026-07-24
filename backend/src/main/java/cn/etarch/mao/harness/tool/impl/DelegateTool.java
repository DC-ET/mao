package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.core.AgentExecutionContext;
import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.delegate.AgentDefinition;
import cn.etarch.mao.harness.delegate.AgentDefinitionRegistry;
import cn.etarch.mao.harness.delegate.SubAgentResultCollector;
import cn.etarch.mao.harness.delegate.SubAgentVisibilityService;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.harness.tool.ToolCallContext;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * 子智能体委派工具。主 Agent 通过调用此工具将子任务委派给专用子代理。
 */
@Slf4j
@Component
public class DelegateTool implements Tool {

    private final AgentDefinitionRegistry definitionRegistry;
    private final HarnessService harnessService;
    private final AgentLoop agentLoop;
    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final SubagentExecutionMapper subagentExecutionMapper;
    private final LocalToolSessionRegistry localToolSessionRegistry;
    private final SubAgentVisibilityService visibilityService;
    private final ObjectMapper objectMapper;

    public DelegateTool(AgentDefinitionRegistry definitionRegistry,
                        @Lazy HarnessService harnessService,
                        @Lazy AgentLoop agentLoop,
                        SessionService sessionService,
                        SessionMapper sessionMapper,
                        SubagentExecutionMapper subagentExecutionMapper,
                        LocalToolSessionRegistry localToolSessionRegistry,
                        SubAgentVisibilityService visibilityService,
                        ObjectMapper objectMapper) {
        this.definitionRegistry = definitionRegistry;
        this.harnessService = harnessService;
        this.agentLoop = agentLoop;
        this.sessionService = sessionService;
        this.sessionMapper = sessionMapper;
        this.subagentExecutionMapper = subagentExecutionMapper;
        this.localToolSessionRegistry = localToolSessionRegistry;
        this.visibilityService = visibilityService;
        this.objectMapper = objectMapper;
    }

    @Override
    public String getName() {
        return "delegate";
    }

    @Override
    public String getDescription() {
        return "将子任务委派给专用子代理执行。子代理拥有独立会话和工具集，专注完成指定任务后返回结果。\n\n"
                + "何时使用：\n"
                + "- 任务可以拆分为独立的子任务\n"
                + "- 某个子任务需要不同的专注策略（如纯研究、纯编码、代码审查）\n"
                + "- 子任务的上下文与当前对话不同，需要隔离执行\n\n"
                + "何时不要使用：\n"
                + "- 简单的单步任务\n"
                + "- 需要与用户交互的子任务（子代理无法直接与用户对话）\n"
                + "- 子任务之间有强依赖关系（请串行调用）";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        List<String> agentNames = definitionRegistry.getAllDefinitions().stream()
                .map(AgentDefinition::getName)
                .collect(Collectors.toList());

        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");

        Map<String, Object> properties = new LinkedHashMap<>();

        Map<String, Object> agentTypeProp = new LinkedHashMap<>();
        agentTypeProp.put("type", "string");
        agentTypeProp.put("description", "子代理类型。不同类型擅长不同任务：\n"
                + definitionRegistry.getAllDefinitions().stream()
                        .map(d -> "- " + d.getName() + "：" + d.getDescription())
                        .collect(Collectors.joining("\n")));
        agentTypeProp.put("enum", agentNames);
        properties.put("agent_type", agentTypeProp);

        Map<String, Object> taskProp = new LinkedHashMap<>();
        taskProp.put("type", "string");
        taskProp.put("description", "要委派给子代理的任务描述。应足够具体，包含：\n"
                + "1. 明确的目标\n"
                + "2. 输入数据或上下文\n"
                + "3. 期望的输出格式\n"
                + "4. 约束条件（如有）");
        properties.put("task", taskProp);

        schema.put("properties", properties);
        schema.put("required", List.of("agent_type", "task"));
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String getToolPrompt() {
        StringBuilder sb = new StringBuilder();
        sb.append("## 子代理委派指南\n\n");
        sb.append("使用 `delegate` 工具将子任务委派给专用子代理。子代理拥有独立会话，完成后将结果返回。\n\n");
        sb.append("### 可用子代理类型\n\n");
        for (AgentDefinition def : definitionRegistry.getAllDefinitions()) {
            sb.append("- **").append(def.getName()).append("**：").append(def.getDescription()).append("\n");
        }
        sb.append("\n### 使用原则\n\n");
        sb.append("1. 任务描述要足够具体，包含明确目标、输入数据和期望输出格式\n");
        sb.append("2. 子代理无法与用户交互，不要委派需要用户确认的任务\n");
        sb.append("3. 委派后请分析返回结果，必要时进行补充或修正\n");
        sb.append("4. 对于有依赖关系的子任务，请串行委派（前一个完成后再委派下一个）\n");
        return sb.toString();
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        Session parentSession = null;
        Session childSession = null;
        SubagentExecution execution = null;
        String runExecutionId = null;
        boolean localRegistered = false;
        boolean cancelFlagRegistered = false;
        boolean terminalHandled = false;

        try {
            JsonNode args = objectMapper.readTree(arguments);
            String agentType = args.get("agent_type").asText();
            String task = args.get("task").asText();

            // 1. 查找子智能体定义
            AgentDefinition definition = definitionRegistry.getDefinition(agentType);
            if (definition == null) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "未知的子代理类型: " + agentType,
                        "available_types", definitionRegistry.getAllDefinitions().stream()
                                .map(AgentDefinition::getName).collect(Collectors.toList())));
            }

            // 2. 加载父会话
            parentSession = sessionMapper.selectById(sessionId);
            if (parentSession == null) {
                return objectMapper.writeValueAsString(Map.of("error", "父会话不存在: " + sessionId));
            }

            // 3. 创建子会话（此后任意异常都必须收尾，避免永久 RUNNING）
            String childTitle = "子代理(" + agentType + "): "
                    + (task.length() > 40 ? task.substring(0, 40) + "..." : task);
            childSession = sessionService.createSession(
                    parentSession.getUserId(),
                    parentSession.getAgentId(),
                    childTitle,
                    parentSession.getExecutionMode(),
                    parentSession.getWorkspace(),
                    parentSession.getPermissionLevel(),
                    parentSession.getIsGit(),
                    parentSession.getPlatform(),
                    parentSession.getShellPath(),
                    parentSession.getOsVersion(),
                    parentSession.getModelId());
            childSession.setParentSessionId(sessionId);
            childSession.setSessionType("SUBAGENT");
            childSession.setPhase(null);
            sessionMapper.updateById(childSession);

            log.info("Created sub-agent session {} (type={}) for parent session {}",
                    childSession.getId(), agentType, sessionId);

            // LOCAL 模式下子会话需注册到 LocalToolSessionRegistry，以便工具调用路由到桌面客户端
            if ("LOCAL".equals(parentSession.getExecutionMode())) {
                localToolSessionRegistry.setUserForSession(childSession.getId(), parentSession.getUserId());
                localRegistered = true;
            }

            // 4. 创建审计记录
            execution = new SubagentExecution();
            execution.setParentSessionId(sessionId);
            execution.setChildSessionId(childSession.getId());
            execution.setAgentType(agentType);
            execution.setTaskDescription(task);
            execution.setStatus("RUNNING");
            execution.setStartedAt(LocalDateTime.now());
            subagentExecutionMapper.insert(execution);

            // 5. 保存初始 USER 消息到子会话
            sessionService.saveMessage(childSession.getId(), "USER", task,
                    null, null, null, 0, null);

            // 5.5 通知前端并 auto-subscribe（在执行前，避免丢首包；携带 toolCallId 便于并行委派精确绑定）
            visibilityService.notifySubagentCreated(
                    parentSession, childSession, agentType, task, ToolCallContext.getToolCallId());

            // 6. 构建子上下文，并注册可取消标志（继承父会话 cancel，便于用户停止时打断）
            AgentExecutionContext subContext = buildSubContext(childSession, definition);
            AtomicBoolean parentCancel = agentLoop.getCancelFlag(sessionId);
            AtomicBoolean childCancel = agentLoop.registerCancelFlag(childSession.getId());
            cancelFlagRegistered = true;
            if (parentCancel != null) {
                subContext.setCancelFlag(parentCancel);
                if (parentCancel.get()) {
                    childCancel.set(true);
                }
            }

            // 7. 同步执行子智能体（WS 流式 + 过程落库 + 结果收集）
            SubAgentVisibilityService.VisibleRunResult runResult;
            try {
                boolean skip = childCancel.get();
                if (skip) {
                    log.info("Skip sub-agent session {}: parent already cancelled", childSession.getId());
                }
                runResult = visibilityService.executeVisible(childSession, subContext, skip);
            } finally {
                if (cancelFlagRegistered) {
                    agentLoop.removeCancelFlag(childSession.getId());
                    cancelFlagRegistered = false;
                }
                if (localRegistered) {
                    localToolSessionRegistry.removeSession(childSession.getId());
                    localRegistered = false;
                }
            }

            SubAgentResultCollector resultCollector = runResult.getCollector();
            runExecutionId = runResult.getExecutionId();

            boolean cancelled = childCancel.get()
                    || (parentCancel != null && parentCancel.get());

            // 8. 处理结果（有文本时由 persistence 落库；空终稿 / 失败仍补 ASSISTANT）
            String resultText;
            boolean success = !cancelled && resultCollector.getError() == null;
            String terminalPhase;

            if (cancelled) {
                resultText = "子代理已随父会话取消";
                terminalPhase = "CANCELLED";
                markExecutionTerminal(execution, "CANCELLED", resultText, subContext.getCurrentRound(),
                        resultCollector);
                log.info("Sub-agent session {} cancelled with parent session {}", childSession.getId(), sessionId);
            } else if (success) {
                resultText = resultCollector.getResult();
                // AgentLoop 在 content 为空时不落库；补占位终稿，避免刷新/晚开 Tab 只剩 USER
                boolean emptyFinal = resultText.isEmpty();
                if (emptyFinal) {
                    resultText = "(子代理未产生文本输出)";
                    sessionService.saveMessage(childSession.getId(), "ASSISTANT", resultText,
                            resultCollector.getThinkingContent(), null, null,
                            resultCollector.getTotalUsage() != null
                                    ? resultCollector.getTotalUsage().getTotalTokens() : 0,
                            subContext.getModelConfig() != null
                                    ? subContext.getModelConfig().getId() : null);
                }
                terminalPhase = "COMPLETED";
                markExecutionTerminal(execution, "COMPLETED", resultText, subContext.getCurrentRound(),
                        resultCollector);

                log.info("Sub-agent session {} completed: {} rounds, {} tool calls, {} tokens",
                        childSession.getId(), subContext.getCurrentRound(),
                        resultCollector.getToolCallCount(),
                        resultCollector.getTotalUsage() != null
                                ? resultCollector.getTotalUsage().getTotalTokens() : 0);
            } else {
                String errorMsg = resultCollector.getError() != null
                        ? resultCollector.getError().getMessage() : "子代理执行异常";
                resultText = "子代理执行失败: " + errorMsg;
                terminalPhase = "FAILED";

                // 异常路径可能没有 persistence 终稿，补一条 ASSISTANT 便于回看
                sessionService.saveMessage(childSession.getId(), "ASSISTANT", resultText,
                        null, null, null, 0,
                        subContext.getModelConfig() != null
                                ? subContext.getModelConfig().getId() : null);

                markExecutionTerminal(execution, "FAILED", resultText, subContext.getCurrentRound(),
                        resultCollector);
            }

            visibilityService.finishSubagent(
                    childSession.getId(), parentSession.getUserId(), terminalPhase, runExecutionId);
            terminalHandled = true;

            // 9. 构建返回结果
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("success", success);
            response.put("cancelled", cancelled);
            response.put("agent_type", agentType);
            response.put("child_session_id", childSession.getId());
            response.put("result", resultText);
            if (cancelled) {
                response.put("error", resultText);
            }
            if (resultCollector.getTotalUsage() != null) {
                response.put("usage", Map.of(
                        "prompt_tokens", resultCollector.getTotalUsage().getPromptTokens(),
                        "completion_tokens", resultCollector.getTotalUsage().getCompletionTokens(),
                        "total_tokens", resultCollector.getTotalUsage().getTotalTokens()));
            }
            response.put("rounds", subContext.getCurrentRound());
            response.put("tool_calls", resultCollector.getToolCallCount());

            return objectMapper.writeValueAsString(response);

        } catch (Exception e) {
            log.error("DelegateTool execution failed", e);
            if (childSession != null && !terminalHandled) {
                failCreatedSubagent(childSession, parentSession, execution, runExecutionId, e);
                terminalHandled = true;
            }
            try {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "委派执行失败: " + e.getMessage());
                if (childSession != null) {
                    err.put("child_session_id", childSession.getId());
                    err.put("success", false);
                }
                return objectMapper.writeValueAsString(err);
            } catch (Exception ex) {
                return "{\"error\":\"委派执行失败\"}";
            }
        } finally {
            if (childSession != null) {
                if (cancelFlagRegistered) {
                    try {
                        agentLoop.removeCancelFlag(childSession.getId());
                    } catch (Exception ignored) {
                        // best-effort
                    }
                }
                if (localRegistered) {
                    try {
                        localToolSessionRegistry.removeSession(childSession.getId());
                    } catch (Exception ignored) {
                        // best-effort
                    }
                }
            }
        }
    }

    /**
     * 子会话已创建后发生未捕获异常时：更新审计、推送 FAILED 终态，避免永久卡在 RUNNING。
     */
    private void failCreatedSubagent(Session childSession,
                                     Session parentSession,
                                     SubagentExecution execution,
                                     String runExecutionId,
                                     Exception cause) {
        String resultText = "子代理执行失败: "
                + (cause.getMessage() != null ? cause.getMessage() : cause.getClass().getSimpleName());
        try {
            if (execution != null && execution.getId() != null) {
                markExecutionTerminal(execution, "FAILED", resultText, null, null);
            }
        } catch (Exception e) {
            log.warn("Failed to mark subagent_execution FAILED for child {}: {}",
                    childSession.getId(), e.getMessage());
        }

        try {
            sessionService.saveMessage(childSession.getId(), "ASSISTANT", resultText,
                    null, null, null, 0, null);
        } catch (Exception e) {
            log.warn("Failed to save failure ASSISTANT for child {}: {}",
                    childSession.getId(), e.getMessage());
        }

        Long userId = parentSession != null ? parentSession.getUserId() : childSession.getUserId();
        try {
            visibilityService.finishSubagent(childSession.getId(), userId, "FAILED", runExecutionId);
        } catch (Exception e) {
            log.warn("Failed to finish subagent {} after error: {}", childSession.getId(), e.getMessage());
        }
    }

    private void markExecutionTerminal(SubagentExecution execution,
                                       String status,
                                       String resultText,
                                       Integer rounds,
                                       SubAgentResultCollector collector) {
        execution.setStatus(status);
        execution.setResult(truncate(resultText, 65000));
        execution.setCompletedAt(LocalDateTime.now());
        if (rounds != null) {
            execution.setTotalRounds(rounds);
        }
        if (collector != null && collector.getTotalUsage() != null) {
            execution.setTotalPromptTokens(collector.getTotalUsage().getPromptTokens());
            execution.setTotalCompletionTokens(collector.getTotalUsage().getCompletionTokens());
        }
        subagentExecutionMapper.updateById(execution);
    }

    /**
     * 构建子智能体执行上下文。
     * 复用 HarnessService.buildContext() 获取基础上下文，然后覆盖 system prompt、maxRounds 和工具集。
     */
    private AgentExecutionContext buildSubContext(Session childSession,
                                                  AgentDefinition definition) {
        // 复用 HarnessService 构建基础上下文（含模型配置、环境信息等）
        AgentExecutionContext ctx = harnessService.buildContext(childSession.getId());

        // 覆盖 system prompt
        if (definition.getSystemPromptOverride() != null) {
            ctx.setSystemPrompt(definition.getSystemPromptOverride());
        }

        // 覆盖 maxRounds（经 resolveMaxRounds 规范化，保证下限与 0=安全封顶）
        if (definition.getMaxRounds() != null) {
            ctx.setMaxRounds(HarnessService.resolveMaxRounds(definition.getMaxRounds()));
        }

        // 设置子智能体名称
        ctx.setAgentName(definition.getName() + "-agent");

        // 过滤工具集
        Set<String> excludedNames = new HashSet<>();
        excludedNames.add("delegate"); // 始终排除，防止递归
        if (definition.getExcludedToolNames() != null) {
            excludedNames.addAll(definition.getExcludedToolNames());
        }

        List<Tool> filteredTools = new ArrayList<>();
        for (Tool tool : ctx.getTools()) {
            if (excludedNames.contains(tool.getName())) {
                continue;
            }
            if (definition.getAllowedToolNames() != null && !definition.getAllowedToolNames().isEmpty()) {
                if (!definition.getAllowedToolNames().contains(tool.getName())) {
                    continue;
                }
            }
            filteredTools.add(tool);
        }
        ctx.setTools(filteredTools);

        // 清除 skills（子智能体不需要技能目录，节省 token）
        ctx.setAvailableSkillNames(null);
        ctx.setAvailableSkillDocs(null);

        return ctx;
    }

    private String truncate(String text, int maxLen) {
        if (text == null) return null;
        return text.length() > maxLen ? text.substring(0, maxLen) + "..." : text;
    }
}
