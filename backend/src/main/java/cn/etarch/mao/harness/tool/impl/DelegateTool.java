package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.core.AgentExecutionContext;
import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.delegate.AgentDefinition;
import cn.etarch.mao.harness.delegate.AgentDefinitionRegistry;
import cn.etarch.mao.harness.delegate.SubAgentResultCollector;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.harness.tool.Tool;
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
    private final ObjectMapper objectMapper;

    public DelegateTool(AgentDefinitionRegistry definitionRegistry,
                        @Lazy HarnessService harnessService,
                        @Lazy AgentLoop agentLoop,
                        SessionService sessionService,
                        SessionMapper sessionMapper,
                        SubagentExecutionMapper subagentExecutionMapper,
                        LocalToolSessionRegistry localToolSessionRegistry,
                        ObjectMapper objectMapper) {
        this.definitionRegistry = definitionRegistry;
        this.harnessService = harnessService;
        this.agentLoop = agentLoop;
        this.sessionService = sessionService;
        this.sessionMapper = sessionMapper;
        this.subagentExecutionMapper = subagentExecutionMapper;
        this.localToolSessionRegistry = localToolSessionRegistry;
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
            Session parentSession = sessionMapper.selectById(sessionId);
            if (parentSession == null) {
                return objectMapper.writeValueAsString(Map.of("error", "父会话不存在: " + sessionId));
            }

            // 3. 创建子会话
            String childTitle = "子代理: " + (task.length() > 50 ? task.substring(0, 50) + "..." : task);
            Session childSession = sessionService.createSession(
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
            }

            // 4. 创建审计记录
            SubagentExecution execution = new SubagentExecution();
            execution.setParentSessionId(sessionId);
            execution.setChildSessionId(childSession.getId());
            execution.setTaskDescription(task);
            execution.setStatus("RUNNING");
            execution.setStartedAt(LocalDateTime.now());
            subagentExecutionMapper.insert(execution);

            // 5. 保存初始 USER 消息到子会话
            sessionService.saveMessage(childSession.getId(), "USER", task,
                    null, null, null, 0, null);

            // 6. 构建子上下文
            AgentExecutionContext subContext = buildSubContext(childSession, definition);

            // 7. 同步执行子智能体
            SubAgentResultCollector resultCollector = new SubAgentResultCollector();
            try {
                agentLoop.execute(subContext, resultCollector);
            } catch (Exception e) {
                log.error("Sub-agent execution failed for session {}", childSession.getId(), e);
                resultCollector = null;
            } finally {
                if ("LOCAL".equals(parentSession.getExecutionMode())) {
                    localToolSessionRegistry.removeSession(childSession.getId());
                }
            }

            // 8. 处理结果
            String resultText;
            boolean success = resultCollector != null && resultCollector.getError() == null;

            if (success) {
                resultText = resultCollector.getResult();
                if (resultText.isEmpty()) {
                    resultText = "(子代理未产生文本输出)";
                }

                // 保存 ASSISTANT 消息到子会话
                sessionService.saveMessage(childSession.getId(), "ASSISTANT", resultText,
                        resultCollector.getThinkingContent(), null, null,
                        resultCollector.getTotalUsage() != null
                                ? resultCollector.getTotalUsage().getTotalTokens() : 0,
                        subContext.getModelConfig() != null
                                ? subContext.getModelConfig().getId() : null);

                // 更新审计记录
                execution.setStatus("COMPLETED");
                execution.setResult(truncate(resultText, 65000));
                execution.setCompletedAt(LocalDateTime.now());
                if (resultCollector.getTotalUsage() != null) {
                    execution.setTotalPromptTokens(resultCollector.getTotalUsage().getPromptTokens());
                    execution.setTotalCompletionTokens(resultCollector.getTotalUsage().getCompletionTokens());
                }
                execution.setTotalRounds(subContext.getCurrentRound());
                subagentExecutionMapper.updateById(execution);

                sessionService.updatePhase(childSession.getId(), "COMPLETED");

                log.info("Sub-agent session {} completed: {} rounds, {} tool calls, {} tokens",
                        childSession.getId(), subContext.getCurrentRound(),
                        resultCollector.getToolCallCount(),
                        resultCollector.getTotalUsage() != null
                                ? resultCollector.getTotalUsage().getTotalTokens() : 0);
            } else {
                String errorMsg = resultCollector != null && resultCollector.getError() != null
                        ? resultCollector.getError().getMessage() : "子代理执行异常";
                resultText = "子代理执行失败: " + errorMsg;

                execution.setStatus("FAILED");
                execution.setResult(truncate(resultText, 65000));
                execution.setCompletedAt(LocalDateTime.now());
                subagentExecutionMapper.updateById(execution);

                sessionService.updatePhase(childSession.getId(), "FAILED");
            }

            // 9. 构建返回结果
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("success", success);
            response.put("agent_type", agentType);
            response.put("child_session_id", childSession.getId());
            response.put("result", resultText);
            if (resultCollector != null && resultCollector.getTotalUsage() != null) {
                response.put("usage", Map.of(
                        "prompt_tokens", resultCollector.getTotalUsage().getPromptTokens(),
                        "completion_tokens", resultCollector.getTotalUsage().getCompletionTokens(),
                        "total_tokens", resultCollector.getTotalUsage().getTotalTokens()));
            }
            response.put("rounds", subContext.getCurrentRound());
            response.put("tool_calls", resultCollector != null ? resultCollector.getToolCallCount() : 0);

            return objectMapper.writeValueAsString(response);

        } catch (Exception e) {
            log.error("DelegateTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of("error", "委派执行失败: " + e.getMessage()));
            } catch (Exception ex) {
                return "{\"error\":\"委派执行失败\"}";
            }
        }
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

        // 覆盖 maxRounds
        if (definition.getMaxRounds() != null) {
            ctx.setMaxRounds(definition.getMaxRounds());
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
