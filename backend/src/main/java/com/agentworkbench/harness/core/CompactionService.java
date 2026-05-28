package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.*;
import com.agentworkbench.session.entity.SessionCompaction;
import com.agentworkbench.session.mapper.SessionCompactionMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class CompactionService {

    private final LlmAdapter llmAdapter;
    private final TokenEstimator tokenEstimator;
    private final SessionCompactionMapper sessionCompactionMapper;

    private static final Pattern SUMMARY_PATTERN = Pattern.compile("<summary>(.*?)</summary>", Pattern.DOTALL);
    private static final int MAX_SINGLE_MESSAGE_CHARS = 2000;
    private static final int MAX_TOOL_RESULT_CHARS = 3000;

    // ======================== 会话历史压缩 ========================

    /**
     * 执行会话历史压缩。返回压缩后的消息列表（含摘要 system message + 保留窗口消息）。
     * 如果不需要压缩或压缩失败，返回 null。
     */
    public SessionCompactionResult compactSession(Long sessionId, List<ChatRequest.Message> messages,
                                                   LlmModelConfig modelConfig, CompactionConfig config,
                                                   String currentUserQuestion) {
        if (!config.isEnabled() || messages.isEmpty()) return null;

        long startTime = System.currentTimeMillis();

        // 1. 加载或创建压缩记录
        SessionCompaction record = sessionCompactionMapper.selectOne(
                new QueryWrapper<SessionCompaction>().eq("session_id", sessionId));
        if (record == null) {
            record = new SessionCompaction();
            record.setSessionId(sessionId);
            record.setLastCompactedMsgId(0L);
            record.setCompactCount(0);
            record.setInputTokens(0L);
            record.setOutputTokens(0L);
        }

        long lastCompactedId = record.getLastCompactedMsgId() != null ? record.getLastCompactedMsgId() : 0;

        // 2. 计算保留窗口（最近 recentTurns 轮 = recentTurns * 2 条消息）
        int recentCount = config.getRecentTurns() * 2;
        if (messages.size() <= recentCount) return null;

        // 可压缩消息 = 从头到 (size - recentCount)
        int compactEnd = messages.size() - recentCount;

        // 如果已有摘要，跳过已被覆盖的消息
        // lastCompactedId 表示已覆盖到第几条消息（按顺序编号，从 1 开始）
        int compactStart = (int) lastCompactedId;
        if (compactStart >= compactEnd) return null;

        List<ChatRequest.Message> toCompact = new ArrayList<>(messages.subList(compactStart, compactEnd));
        List<ChatRequest.Message> recentMessages = new ArrayList<>(messages.subList(compactEnd, messages.size()));

        // 3. 判断是否需要压缩
        int newTokenCount = tokenEstimator.estimateMessages(toCompact);
        int totalTokenEstimate = tokenEstimator.estimateMessages(messages);

        boolean shouldCompact = false;
        if (newTokenCount >= config.getMinNewTokenCount()) {
            shouldCompact = true;
        } else if (toCompact.size() >= config.getMinNewMessageCount()
                && toCompact.size() >= config.getMinCompactMessageCount()
                && totalTokenEstimate >= config.getContextWindowTokens() * config.getTriggerRatio()) {
            shouldCompact = true;
        }

        if (!shouldCompact) return null;

        log.info("Session compaction triggered for session {}: {} messages ({} tokens) to compact, {} total tokens",
                sessionId, toCompact.size(), newTokenCount, totalTokenEstimate);

        // 4. 分批压缩
        String existingSummary = record.getSummaryText();
        int totalCompacted = 0;
        int totalInputTokens = 0;
        int totalOutputTokens = 0;

        int batchStart = 0;
        int rounds = 0;
        while (batchStart < toCompact.size() && rounds < config.getMaxRoundsPerRequest()) {
            int batchEnd = Math.min(batchStart + config.getMaxCompactionBatchMessages(), toCompact.size());
            List<ChatRequest.Message> batch = toCompact.subList(batchStart, batchEnd);

            String formattedHistory = formatMessagesForCompaction(batch);
            String compactionPrompt = buildSessionCompactionPrompt(existingSummary, formattedHistory, currentUserQuestion);

            CompactionLlmResult llmResult = callCompactionModel(compactionPrompt, modelConfig);
            if (llmResult == null || llmResult.summaryText == null || llmResult.summaryText.isBlank()) {
                log.warn("Session compaction LLM call returned empty result for session {}", sessionId);
                break;
            }

            existingSummary = llmResult.summaryText;
            totalCompacted += batch.size();
            totalInputTokens += llmResult.inputTokens;
            totalOutputTokens += llmResult.outputTokens;

            batchStart = batchEnd;
            rounds++;
        }

        if (totalCompacted == 0) return null;

        // 5. 更新压缩记录
        record.setSummaryText(existingSummary);
        record.setLastCompactedMsgId((long) (compactStart + totalCompacted));
        record.setCompactCount(record.getCompactCount() + 1);
        record.setInputTokens(record.getInputTokens() + totalInputTokens);
        record.setOutputTokens(record.getOutputTokens() + totalOutputTokens);
        if (modelConfig != null) {
            record.setCompactModel(modelConfig.getModelId());
        }

        if (record.getId() == null) {
            sessionCompactionMapper.insert(record);
        } else {
            sessionCompactionMapper.updateById(record);
        }

        // 6. 重建消息列表：摘要 system message + 保留窗口
        int summaryTokens = tokenEstimator.countTokens(existingSummary);
        int savedTokens = newTokenCount - summaryTokens;

        log.info("Session compaction completed for session {}: compacted {} messages, saved ~{} tokens (took {}ms)",
                sessionId, totalCompacted, savedTokens, System.currentTimeMillis() - startTime);

        List<ChatRequest.Message> result = new ArrayList<>();
        result.add(ChatRequest.Message.builder()
                .role("system")
                .content(buildSummaryInjectionPrompt(existingSummary))
                .build());
        result.addAll(recentMessages);

        return new SessionCompactionResult(result, existingSummary, toCompact.size(), summaryTokens, savedTokens,
                System.currentTimeMillis() - startTime);
    }

    // ======================== Loop 工作记忆压缩 ========================

    /**
     * 执行 loop 工作记忆压缩。返回压缩后的消息列表。
     * 如果不需要压缩或压缩失败，返回 null。
     * @param existingWorkingSummary 之前已有的工作摘要（同一请求内累积），可为 null
     */
    public LoopCompactionResult compactLoop(List<ChatRequest.Message> messages,
                                             LlmModelConfig modelConfig, CompactionConfig config,
                                             String existingWorkingSummary) {
        if (!config.isLoopEnabled() || messages.isEmpty()) return null;

        long startTime = System.currentTimeMillis();

        // 1. 找到最后一条用户消息的位置
        int lastUserIdx = -1;
        for (int i = messages.size() - 1; i >= 0; i--) {
            if ("user".equals(messages.get(i).getRole())) {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0) return null;

        // 2. 工作区消息 = lastUserIdx 之后的全部消息
        List<ChatRequest.Message> prefix = new ArrayList<>(messages.subList(0, lastUserIdx + 1));
        List<ChatRequest.Message> workspace = new ArrayList<>(messages.subList(lastUserIdx + 1, messages.size()));

        if (workspace.size() < 4) return null; // 太少不需要压缩

        // 3. 统计工具轮次
        int toolRounds = 0;
        for (ChatRequest.Message msg : workspace) {
            if ("assistant".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                toolRounds++;
            }
        }

        // 4. 判断是否触发
        int workspaceTokens = tokenEstimator.estimateMessages(workspace);
        boolean shouldCompact = toolRounds >= config.getLoopTriggerToolRounds()
                || workspaceTokens >= config.getLoopTriggerTokens();

        if (!shouldCompact) return null;

        // 5. 保留最近 N 轮原始工具交互
        int keepRounds = config.getLoopRecentToolRounds();
        int keepStart = workspace.size();
        int roundsFound = 0;
        for (int i = workspace.size() - 1; i >= 0; i--) {
            ChatRequest.Message msg = workspace.get(i);
            if ("assistant".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                roundsFound++;
                if (roundsFound > keepRounds) {
                    keepStart = i;
                    break;
                }
            }
        }
        if (roundsFound <= keepRounds) return null; // 工具轮次不够，不值得压缩

        List<ChatRequest.Message> toCompact = new ArrayList<>(workspace.subList(0, keepStart));
        List<ChatRequest.Message> keepMessages = new ArrayList<>(workspace.subList(keepStart, workspace.size()));

        if (toCompact.isEmpty()) return null;

        log.info("Loop compaction triggered: {} messages to compact, {} tool rounds, {} workspace tokens",
                toCompact.size(), toolRounds, workspaceTokens);

        // 6. 提取已有工作摘要
        // 工作摘要不跨请求持久化，但可以在同一请求内累积

        String formattedHistory = formatMessagesForCompaction(toCompact);
        String compactionPrompt = buildLoopCompactionPrompt(existingWorkingSummary, formattedHistory);

        CompactionLlmResult llmResult = callCompactionModel(compactionPrompt, modelConfig);
        if (llmResult == null || llmResult.summaryText == null || llmResult.summaryText.isBlank()) {
            log.warn("Loop compaction LLM call returned empty result");
            return null;
        }

        // 7. 重建消息列表
        int summaryTokens = tokenEstimator.countTokens(llmResult.summaryText);
        int savedTokens = workspaceTokens - summaryTokens - tokenEstimator.estimateMessages(keepMessages);

        log.info("Loop compaction completed: saved ~{} tokens (took {}ms)",
                savedTokens, System.currentTimeMillis() - startTime);

        List<ChatRequest.Message> result = new ArrayList<>(prefix);
        result.add(ChatRequest.Message.builder()
                .role("system")
                .content(buildWorkingSummaryInjectionPrompt(llmResult.summaryText))
                .build());
        result.addAll(keepMessages);

        return new LoopCompactionResult(result, llmResult.summaryText, toCompact.size(), summaryTokens,
                Math.max(0, savedTokens), System.currentTimeMillis() - startTime);
    }

    // ======================== 内部方法 ========================

    /**
     * 格式化消息为压缩友好的文本
     */
    private String formatMessagesForCompaction(List<ChatRequest.Message> messages) {
        StringBuilder sb = new StringBuilder();
        for (ChatRequest.Message msg : messages) {
            switch (msg.getRole()) {
                case "user" -> {
                    sb.append("用户: ").append(truncate(msg.getContent(), MAX_SINGLE_MESSAGE_CHARS)).append("\n\n");
                }
                case "assistant" -> {
                    if (msg.getContent() != null && !msg.getContent().isEmpty()) {
                        sb.append("助手: ").append(truncate(msg.getContent(), MAX_SINGLE_MESSAGE_CHARS)).append("\n");
                    }
                    if (msg.getToolCalls() != null) {
                        for (ChatRequest.ToolCall tc : msg.getToolCalls()) {
                            if (tc.getFunction() != null) {
                                sb.append("[工具调用] ").append(tc.getFunction().getName());
                                if (tc.getFunction().getArguments() != null) {
                                    sb.append("(").append(truncate(tc.getFunction().getArguments(), 500)).append(")");
                                }
                                sb.append("\n");
                            }
                        }
                    }
                    sb.append("\n");
                }
                case "tool" -> {
                    String toolName = msg.getToolCallId() != null ? msg.getToolCallId() : "unknown";
                    sb.append("工具结果[").append(toolName).append("]: ")
                            .append(truncate(msg.getContent(), MAX_TOOL_RESULT_CHARS)).append("\n\n");
                }
                case "system" -> {
                    sb.append("[系统] ").append(truncate(msg.getContent(), MAX_SINGLE_MESSAGE_CHARS)).append("\n\n");
                }
            }
        }
        return sb.toString();
    }

    private String truncate(String text, int maxChars) {
        if (text == null) return "";
        if (text.length() <= maxChars) return text;
        return text.substring(0, maxChars / 2) + "\n... [truncated] ...\n" + text.substring(text.length() - maxChars / 2);
    }

    private String buildSessionCompactionPrompt(String existingSummary, String history, String currentQuestion) {
        StringBuilder sb = new StringBuilder();
        sb.append("你是一个会话压缩助手。你的任务是将以下对话历史压缩为一段简洁的摘要，以便 Agent 在后续执行中能延续任务。\n\n");
        sb.append("摘要要求：\n");
        sb.append("1. 保留用户明确请求和意图\n");
        sb.append("2. 保留关键技术概念、架构判断和决策\n");
        sb.append("3. 保留文件路径、接口、命令、错误、测试结果、版本号\n");
        sb.append("4. 保留已完成事项、未完成待办、当前停留位置\n");
        sb.append("5. 保留与当前请求最相关的下一步\n");
        sb.append("6. 不要泛泛总结，要保留可执行的具体信息\n\n");

        if (existingSummary != null && !existingSummary.isBlank()) {
            sb.append("## 已有摘要\n\n").append(existingSummary).append("\n\n");
        }

        sb.append("## 待压缩的对话历史\n\n").append(history).append("\n\n");

        if (currentQuestion != null && !currentQuestion.isBlank()) {
            sb.append("## 当前用户问题\n\n").append(currentQuestion).append("\n\n");
        }

        sb.append("请生成融合后的统一摘要。用 <summary> 标签包裹摘要正文。\n");

        return sb.toString();
    }

    private String buildSummaryInjectionPrompt(String summary) {
        return "## 会话历史摘要\n\n"
                + "以下是之前对话的压缩摘要，请将其作为历史事实参考：\n\n"
                + summary + "\n\n"
                + "请延续用户目标、约束、已完成事项和未完成待办。避免重复检索或重复执行已完成步骤。"
                + "如果摘要与后续原始消息冲突，以后续原始消息为准。";
    }

    private String buildLoopCompactionPrompt(String existingSummary, String history) {
        StringBuilder sb = new StringBuilder();
        sb.append("你是一个工作记忆压缩助手。你的任务是将以下工具调用链路压缩为工作摘要，以便 Agent 继续执行当前任务。\n\n");
        sb.append("摘要要求：\n");
        sb.append("1. 保留当前目标\n");
        sb.append("2. 保留已完成动作\n");
        sb.append("3. 保留关键发现（文件内容、错误信息、搜索结果）\n");
        sb.append("4. 保留关键路径、对象、参数\n");
        sb.append("5. 保留当前状态和下一步待做\n\n");

        if (existingSummary != null && !existingSummary.isBlank()) {
            sb.append("## 已有工作摘要\n\n").append(existingSummary).append("\n\n");
        }

        sb.append("## 工具调用链路\n\n").append(history).append("\n\n");

        sb.append("请生成工作摘要。用 <summary> 标签包裹摘要正文。\n");

        return sb.toString();
    }

    private String buildWorkingSummaryInjectionPrompt(String summary) {
        return "## 工作记忆摘要\n\n"
                + "以下是当前任务较早的工具调用链路压缩摘要：\n\n"
                + summary + "\n\n"
                + "这是工具调用链路的延续。如果工作摘要与后续原始工具结果冲突，以后续原始消息为准。";
    }

    private CompactionLlmResult callCompactionModel(String prompt, LlmModelConfig modelConfig) {
        try {
            List<ChatRequest.Message> msgs = List.of(
                    ChatRequest.Message.builder().role("user").content(prompt).build()
            );

            ChatRequest request = ChatRequest.builder()
                    .messages(msgs)
                    .stream(false)
                    .build();

            ChatResponse response = llmAdapter.chat(request, modelConfig);
            if (response == null || response.getChoices() == null || response.getChoices().isEmpty()) {
                return null;
            }

            String content = response.getChoices().get(0).getMessage().getContent();
            if (content == null || content.isBlank()) return null;

            // 提取 <summary> 标签内容
            String summaryText = content;
            Matcher matcher = SUMMARY_PATTERN.matcher(content);
            if (matcher.find()) {
                summaryText = matcher.group(1).trim();
            }

            int inputTokens = response.getUsage() != null ? response.getUsage().getPromptTokens() : 0;
            int outputTokens = response.getUsage() != null ? response.getUsage().getCompletionTokens() : 0;

            return new CompactionLlmResult(summaryText, inputTokens, outputTokens);
        } catch (Exception e) {
            log.error("Compaction LLM call failed", e);
            return null;
        }
    }

    // ======================== 结果类 ========================

    private record CompactionLlmResult(String summaryText, int inputTokens, int outputTokens) {}

    public record SessionCompactionResult(
            List<ChatRequest.Message> compactedMessages,
            String summaryText,
            int compactedCount,
            int summaryTokens,
            int savedTokens,
            long durationMs
    ) {}

    public record LoopCompactionResult(
            List<ChatRequest.Message> compactedMessages,
            String summaryText,
            int compactedCount,
            int summaryTokens,
            int savedTokens,
            long durationMs
    ) {}
}
