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
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 子代理追问工具。主 Agent 对既有子代理会话发起追问（续查），复用其完整历史上下文
 * 做增量核查，避免重新新建子代理全量分析。
 */
@Slf4j
@Component
public class DelegateFollowupTool implements Tool {

    private final AgentDefinitionRegistry definitionRegistry;
    private final HarnessService harnessService;
    private final AgentLoop agentLoop;
    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final SessionCompactionService sessionCompactionService;
    private final SubagentExecutionMapper subagentExecutionMapper;
    private final LocalToolSessionRegistry localToolSessionRegistry;
    private final SubAgentVisibilityService visibilityService;
    private final DelegateTool delegateTool;
    private final ObjectMapper objectMapper;

    public DelegateFollowupTool(AgentDefinitionRegistry definitionRegistry,
                                @Lazy HarnessService harnessService,
                                @Lazy AgentLoop agentLoop,
                                SessionService sessionService,
                                SessionMapper sessionMapper,
                                MessageMapper messageMapper,
                                SessionCompactionService sessionCompactionService,
                                SubagentExecutionMapper subagentExecutionMapper,
                                LocalToolSessionRegistry localToolSessionRegistry,
                                SubAgentVisibilityService visibilityService,
                                @Lazy DelegateTool delegateTool,
                                ObjectMapper objectMapper) {
        this.definitionRegistry = definitionRegistry;
        this.harnessService = harnessService;
        this.agentLoop = agentLoop;
        this.sessionService = sessionService;
        this.sessionMapper = sessionMapper;
        this.messageMapper = messageMapper;
        this.sessionCompactionService = sessionCompactionService;
        this.subagentExecutionMapper = subagentExecutionMapper;
        this.localToolSessionRegistry = localToolSessionRegistry;
        this.visibilityService = visibilityService;
        this.delegateTool = delegateTool;
        this.objectMapper = objectMapper;
    }

    @Override
    public String getName() {
        return "delegate_followup";
    }

    @Override
    public String getDescription() {
        return "对既有子代理会话发起追问（续查）。子代理保留上次全部上下文，"
                + "基于你描述的最新状态做增量核查，适合「审查 → 修复 → 再审查」闭环。\n\n"
                + "何时使用：\n"
                + "- 已有子代理完成过任务（如代码审查），你修复了其发现的问题，需要它核查修复情况并继续审查\n"
                + "- 需要基于上次结论增量推进，而不是重新全量分析\n\n"
                + "何时不要使用：\n"
                + "- 全新任务（请使用 delegate 新建子代理）\n"
                + "- 没有对应的 child_session_id（需先从 delegate 返回结果获取）\n"
                + "- 目标子代理与本次问题无关";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");

        Map<String, Object> properties = new LinkedHashMap<>();

        Map<String, Object> childSessionIdProp = new LinkedHashMap<>();
        childSessionIdProp.put("type", "integer");
        childSessionIdProp.put("description", "要追问的子代理会话 id，取自历史中 delegate 或上一次 delegate_followup 工具返回结果的 child_session_id 字段，支持连续多轮追问");
        properties.put("child_session_id", childSessionIdProp);

        Map<String, Object> taskProp = new LinkedHashMap<>();
        taskProp.put("type", "string");
        taskProp.put("description", "追问任务描述。应说明：上次结论、本次修复/变更内容、期望核查的重点、输出格式。"
                + "子代理会保留上次全部上下文做增量核查");
        properties.put("task", taskProp);

        schema.put("properties", properties);
        schema.put("required", List.of("child_session_id", "task"));
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String getToolPrompt() {
        StringBuilder sb = new StringBuilder();
        sb.append("## 子代理追问\n\n");
        sb.append("使用 `delegate_followup` 工具对既有子代理会话发起追问，复用其历史上下文做增量核查。\n\n");
        sb.append("### 使用步骤\n\n");
        sb.append("1. 从历史工具结果中找到目标子代理的 `child_session_id`（`delegate` 返回的 `child_session_id` 字段）\n");
        sb.append("2. 在 `task` 中描述本次变更内容与核查重点，调用 `delegate_followup`\n\n");
        sb.append("### 使用原则\n\n");
        sb.append("1. 子代理保留上次全部上下文（上次结论、工具输出），会自动聚焦增量核查，不要让它重新全量分析\n");
        sb.append("2. 追问任务描述要具体：列出上次结论、本次修复内容、期望核查点\n");
        sb.append("3. 子代理可用文件/git 工具核实实际改动，可要求它确认修复是否到位\n");
        sb.append("4. 子代理无法与用户交互\n");
        sb.append("5. 全新任务请使用 `delegate` 新建子代理，不要追问无关子代理\n");
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
        boolean claimed = false;
        String originalPhase = null;

        try {
            JsonNode args = objectMapper.readTree(arguments);
            if (args == null || !args.isObject()) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "无效的JSON参数"
                ));
            }
            Long childSessionId = null;
            if (args.has("child_session_id") && !args.get("child_session_id").isNull()) {
                JsonNode idNode = args.get("child_session_id");
                if (!idNode.isIntegralNumber() || !idNode.canConvertToLong()) {
                    return objectMapper.writeValueAsString(Map.of(
                            "error", "参数 child_session_id 必须是整数"
                    ));
                }
                childSessionId = idNode.asLong();
            }
            String task = args.has("task") && !args.get("task").isNull() ? args.get("task").asText() : null;
            if (childSessionId == null || task == null || task.isBlank()) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "缺少必填参数: child_session_id, task"
                ));
            }

            // 1. 加载父会话
            parentSession = sessionMapper.selectById(sessionId);
            if (parentSession == null) {
                return objectMapper.writeValueAsString(Map.of("error", "父会话不存在: " + sessionId));
            }

            // 2. 校验子会话：存在 / SUBAGENT / 归属当前父会话 / 非 RUNNING
            childSession = sessionMapper.selectById(childSessionId);
            if (childSession == null) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "子代理会话不存在: " + childSessionId
                ));
            }
            if (!"SUBAGENT".equals(childSession.getSessionType())) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "会话 " + childSessionId + " 不是子代理会话，无法追问"
                ));
            }
            if (!Objects.equals(childSession.getParentSessionId(), sessionId)) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "子代理会话 " + childSessionId + " 不属于当前会话，无法追问"
                ));
            }
            if ("RUNNING".equals(childSession.getPhase())) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "子代理会话 " + childSessionId + " 正在执行中，无法追问"
                ));
            }

            // 3. 反查该子会话的代理类型（最近一次执行记录），并解析定义
            String agentType = resolveAgentType(childSessionId);
            if (agentType == null) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "子代理会话 " + childSessionId + " 无执行记录，无法追问"
                ));
            }
            AgentDefinition definition = definitionRegistry.getDefinition(agentType);
            if (definition == null) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "未知的子代理类型: " + agentType
                ));
            }

            // 4. 原子抢占执行权：仅当当前非 RUNNING 时置 RUNNING。
            // 双重作用：
            //   1) 防并行追问同一子会话的竞态（AgentLoop 同轮工具调用并行执行，check-then-act 必须原子化）；
            //   2) 保证 finish 前 phase 处于非终态，避免 skip 路径（父会话已取消）下
            //      TaskTerminalService.finishExecution 的终态守卫直接 return，导致 phase 不更新、无 WS 事件。
            // 注意：SQL 三值逻辑下 `phase <> 'RUNNING'` 对 NULL 不匹配，必须显式覆盖 NULL（崩溃窗口
            // 下子会话可能 phase=NULL 且不被 CrashRecoveryRunner 恢复，否则将永久无法追问）。
            originalPhase = childSession.getPhase();
            int claimedRows = sessionMapper.update(null, new LambdaUpdateWrapper<Session>()
                    .eq(Session::getId, childSessionId)
                    .and(w -> w.ne(Session::getPhase, "RUNNING").or().isNull(Session::getPhase))
                    .set(Session::getPhase, "RUNNING"));
            if (claimedRows == 0) {
                return objectMapper.writeValueAsString(Map.of(
                        "error", "子代理会话 " + childSessionId + " 正在执行中，无法追问"
                ));
            }
            claimed = true;

            // 5. 先清理子会话不完整尾部（与 buildContext 同粒度，含 compaction 边界），
            //    避免刚落库的追问 USER 消息被随后 buildContext 的 cleanupIncompleteTailAfterId
            //    误删（上次执行异常中断残留不完整轮的场景；追问允许对 FAILED 子会话发起）。
            SessionCompaction compactionRecord = sessionCompactionService.loadValidated(childSessionId);
            long boundary = sessionCompactionService.boundaryOf(compactionRecord);
            sessionService.cleanupIncompleteTailAfterId(childSessionId, boundary);

            // 5.5 清理尾部孤立 USER（其后无任何回复，如前一轮 delegate 首轮被取消的遗留），
            //     避免连续 USER 消息导致部分 LLM 端点 400。
            while (true) {
                Message lastMsg = messageMapper.selectOne(new LambdaQueryWrapper<Message>()
                        .eq(Message::getSessionId, childSessionId)
                        .orderByDesc(Message::getId)
                        .last("LIMIT 1"));
                if (lastMsg == null || !"USER".equals(lastMsg.getRole())) {
                    break;
                }
                messageMapper.deleteById(lastMsg.getId());
                log.info("Removed orphan USER message {} before follow-up of sub-agent session {}",
                        lastMsg.getId(), childSessionId);
            }

            // 6. 保存追问 USER 消息（与普通聊天一致，前端无需特殊处理）。
            //    记录消息 id：取消/skip 时回滚本次追问产生的消息，避免「无应答 USER」滞留历史。
            Message savedUserMessage = sessionService.saveMessage(childSessionId, "USER", task,
                    null, null, null, 0, null);

            // 7. 插入本次执行审计记录
            execution = new SubagentExecution();
            execution.setParentSessionId(sessionId);
            execution.setChildSessionId(childSessionId);
            execution.setAgentType(agentType);
            execution.setInvocationType("FOLLOWUP");
            execution.setParentToolCallId(ToolCallContext.getToolCallId());
            execution.setDeliveryStatus("PENDING");
            execution.setExecutionStartMessageId(savedUserMessage != null ? savedUserMessage.getId() : null);
            execution.setTaskDescription(task);
            execution.setStatus("RUNNING");
            execution.setStartedAt(LocalDateTime.now());
            subagentExecutionMapper.insert(execution);

            // 8. LOCAL 模式下子会话注册到 LocalToolSessionRegistry
            if ("LOCAL".equals(parentSession.getExecutionMode())) {
                localToolSessionRegistry.setUserForSession(childSessionId, parentSession.getUserId());
                localRegistered = true;
            }

            // 9. 确保 WS 订阅有效（兜底：Tab 已存在时正常可见）
            visibilityService.ensureSubscribed(parentSession.getUserId(), childSessionId);

            // 10. 构建子上下文（复用 DelegateTool 逻辑，自动加载历史 + 本次追问）
            AgentExecutionContext subContext = delegateTool.buildSubContext(childSession, definition);

            // 11. 注册取消标志（继承父会话 cancel）
            AtomicBoolean parentCancel = agentLoop.getCancelFlag(sessionId);
            AtomicBoolean childCancel = agentLoop.registerCancelFlag(childSessionId);
            cancelFlagRegistered = true;
            if (parentCancel != null) {
                subContext.setCancelFlag(parentCancel);
                if (parentCancel.get()) {
                    childCancel.set(true);
                }
            }

            // 12. 同步执行子智能体（WS 流式 + 过程落库 + 结果收集），直到完成或被取消。
            SubAgentVisibilityService.VisibleRunResult runResult;
            boolean skip = childCancel.get();
            try {
                if (skip) {
                    log.info("Skip follow-up of sub-agent session {}: parent already cancelled", childSessionId);
                }
                runResult = visibilityService.executeVisible(childSession, subContext, skip, childCancel);
            } finally {
                if (cancelFlagRegistered) {
                    agentLoop.removeCancelFlag(childSessionId);
                    cancelFlagRegistered = false;
                }
                if (localRegistered) {
                    localToolSessionRegistry.removeSession(childSessionId);
                    localRegistered = false;
                }
            }

            SubAgentResultCollector resultCollector = runResult.getCollector();
            runExecutionId = runResult.getExecutionId();

            boolean cancelled = childCancel.get()
                    || (parentCancel != null && parentCancel.get());

            // 13. 处理结果（有文本时由 persistence 落库；空终稿 / 失败仍补 ASSISTANT）
            String resultText;
            boolean success = !cancelled && resultCollector.getError() == null;
            String terminalPhase;

            if (cancelled) {
                if (skip && originalPhase != null && isTerminalPhase(originalPhase)) {
                    // 追问未实际执行（父会话已取消）：恢复子会话原终态，避免「已完成」历史被改写为 CANCELLED。
                    // 写回前重读当前 phase，仅当仍为本追问抢占的 RUNNING 时才恢复（防极端串行交错覆盖新终态）。
                    // 后续 finishSubagent 会被 TaskTerminalService 终态守卫拦截（终态→终态不更新）。
                    Session current = sessionMapper.selectById(childSessionId);
                    if (current != null && "RUNNING".equals(current.getPhase())) {
                        sessionMapper.update(null, new LambdaUpdateWrapper<Session>()
                                .eq(Session::getId, childSessionId)
                                .set(Session::getPhase, originalPhase));
                        log.info("Follow-up of sub-agent session {} skipped (parent cancelled), restore phase {}",
                                childSessionId, originalPhase);
                    }
                }
                // 回滚本次追问产生的消息（追问 USER 及其后所有消息），避免「无应答 USER」滞留历史、
                // 以及连续 USER 消息导致部分 LLM 端点 400。
                if (savedUserMessage != null && savedUserMessage.getId() != null) {
                    messageMapper.delete(new LambdaQueryWrapper<Message>()
                            .eq(Message::getSessionId, childSessionId)
                            .ge(Message::getId, savedUserMessage.getId()));
                    log.info("Rolled back follow-up messages of sub-agent session {} (from message id {})",
                            childSessionId, savedUserMessage.getId());
                }
                resultText = "子代理已随父会话取消";
                terminalPhase = "CANCELLED";
                markExecutionTerminal(execution, "CANCELLED", resultText, subContext.getCurrentRound(),
                        resultCollector);
                log.info("Follow-up of sub-agent session {} cancelled with parent session {}", childSessionId, sessionId);
            } else if (success) {
                resultText = resultCollector.getResult();
                boolean emptyFinal = resultText.isEmpty();
                if (emptyFinal) {
                    resultText = "(子代理未产生文本输出)";
                    sessionService.saveMessage(childSessionId, "ASSISTANT", resultText,
                            resultCollector.getThinkingContent(), null, null,
                            resultCollector.getTotalUsage() != null
                                    ? resultCollector.getTotalUsage().getTotalTokens() : 0,
                            subContext.getModelConfig() != null
                                    ? subContext.getModelConfig().getId() : null);
                }
                terminalPhase = "COMPLETED";
                markExecutionTerminal(execution, "COMPLETED", resultText, subContext.getCurrentRound(),
                        resultCollector);
                log.info("Follow-up of sub-agent session {} completed: {} rounds, {} tool calls, {} tokens",
                        childSessionId, subContext.getCurrentRound(),
                        resultCollector.getToolCallCount(),
                        resultCollector.getTotalUsage() != null
                                ? resultCollector.getTotalUsage().getTotalTokens() : 0);
            } else {
                String errorMsg = resultCollector.getError() != null
                        ? resultCollector.getError().getMessage() : "子代理执行异常";
                resultText = "子代理执行失败: " + errorMsg;
                terminalPhase = "FAILED";
                sessionService.saveMessage(childSessionId, "ASSISTANT", resultText,
                        null, null, null, 0,
                        subContext.getModelConfig() != null
                                ? subContext.getModelConfig().getId() : null,
                        "{\"subagentTerminalStatus\":\"FAILED\"}");
                markExecutionTerminal(execution, "FAILED", resultText, subContext.getCurrentRound(),
                        resultCollector);
            }

            visibilityService.finishSubagent(childSessionId, parentSession.getUserId(), terminalPhase, runExecutionId);
            terminalHandled = true;

            // 14. 构建返回结果（round = 该子会话累计执行次数，completed_rounds = 成功完成轮次）
            long round = subagentExecutionMapper.selectCount(
                    new LambdaQueryWrapper<SubagentExecution>()
                            .eq(SubagentExecution::getChildSessionId, childSessionId));
            long completedRounds = subagentExecutionMapper.selectCount(
                    new LambdaQueryWrapper<SubagentExecution>()
                            .eq(SubagentExecution::getChildSessionId, childSessionId)
                            .eq(SubagentExecution::getStatus, "COMPLETED"));
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("success", success);
            response.put("cancelled", cancelled);
            response.put("follow_up", true);
            response.put("agent_type", agentType);
            response.put("child_session_id", childSessionId);
            response.put("round", round);
            response.put("completed_rounds", completedRounds);
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
            log.error("DelegateFollowupTool execution failed", e);
            // 仅当已抢占执行权（追问已开始）时走收尾；抢占前的异常（如反查/定义解析失败）
            // 直接返回错误，避免向子会话写入虚假的「执行失败」ASSISTANT 消息污染历史。
            if (childSession != null && claimed && !terminalHandled) {
                failCreatedSubagent(childSession, parentSession, execution, runExecutionId, e);
                terminalHandled = true;
            }
            try {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "追问执行失败: " + e.getMessage());
                if (childSession != null) {
                    err.put("child_session_id", childSession.getId());
                    err.put("success", false);
                }
                return objectMapper.writeValueAsString(err);
            } catch (Exception serializeEx) {
                log.warn("Failed to serialize follow-up error", serializeEx);
                return "{\"error\":\"追问执行失败: " + (serializeEx.getMessage() != null
                        ? serializeEx.getMessage() : "unknown") + "\"}";
            } finally {
                if (claimed) {
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
     * 反查子会话最近一次执行记录的代理类型。
     */
    private String resolveAgentType(Long childSessionId) {
        List<SubagentExecution> list = subagentExecutionMapper.selectList(
                new LambdaQueryWrapper<SubagentExecution>()
                        .eq(SubagentExecution::getChildSessionId, childSessionId)
                        .orderByDesc(SubagentExecution::getId)
                        .last("LIMIT 1"));
        return list.isEmpty() ? null : list.get(0).getAgentType();
    }

    private boolean isTerminalPhase(String phase) {
        return "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase);
    }

    /**
     * 子会话已存在、执行中出现未捕获异常时：更新审计、推送 FAILED 终态，避免永久卡在 RUNNING。
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
        if (collector != null) {
            execution.setTotalToolCalls(collector.getToolCallCount());
            if (collector.getTotalUsage() != null) {
                execution.setTotalPromptTokens(collector.getTotalUsage().getPromptTokens());
                execution.setTotalCompletionTokens(collector.getTotalUsage().getCompletionTokens());
            }
        }
        if (execution.getExecutionStartMessageId() != null) {
            sessionService.getMessagesAfterId(execution.getChildSessionId(), execution.getExecutionStartMessageId())
                    .stream().filter(message -> "ASSISTANT".equals(message.getRole())
                            && (message.getToolCalls() == null || message.getToolCalls().isBlank()))
                    .reduce((first, second) -> second)
                    .ifPresent(message -> execution.setFinalMessageId(message.getId()));
        }
        subagentExecutionMapper.updateById(execution);
    }

    private String truncate(String text, int maxLen) {
        if (text == null) return null;
        return text.length() > maxLen ? text.substring(0, maxLen) + "..." : text;
    }
}
