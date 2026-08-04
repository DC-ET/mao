package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class CompactionService {

    private final LlmAdapter llmAdapter;
    private final TokenEstimator tokenEstimator;

    private static final Pattern SUMMARY_PATTERN = Pattern.compile("<summary>(.*?)</summary>", Pattern.DOTALL);
    private static final int MAX_SINGLE_MESSAGE_CHARS = 2000;
    private static final int MAX_TOOL_RESULT_CHARS = 3000;

    private static final String SYNTHETIC_CONTINUE_USER =
            "（以上为历史压缩摘要）请基于摘要与下方保留的原始工具结果继续完成当前任务，不要重复已完成的步骤。";

    // ======================== 会话历史压缩 ========================

    public SessionCompactionResult compactSession(Long sessionId,
                                                   long expectedOldBoundary,
                                                   String existingSummary,
                                                   List<PersistedChatMessage> messages,
                                                   List<Long> snapshotMessageIds,
                                                   LlmModelConfig modelConfig,
                                                   CompactionConfig config,
                                                   String currentUserQuestion) {
        return compactSession(sessionId, expectedOldBoundary, existingSummary, messages,
                snapshotMessageIds, modelConfig, config, currentUserQuestion, null, false, null);
    }

    public SessionCompactionResult compactSession(Long sessionId,
                                                   long expectedOldBoundary,
                                                   String existingSummary,
                                                   List<PersistedChatMessage> messages,
                                                   List<Long> snapshotMessageIds,
                                                   LlmModelConfig modelConfig,
                                                   CompactionConfig config,
                                                   String currentUserQuestion,
                                                   AgentEventListener listener) {
        return compactSession(sessionId, expectedOldBoundary, existingSummary, messages,
                snapshotMessageIds, modelConfig, config, currentUserQuestion, listener, false, null);
    }

    public SessionCompactionResult compactSession(Long sessionId,
                                                   long expectedOldBoundary,
                                                   String existingSummary,
                                                   List<PersistedChatMessage> messages,
                                                   List<Long> snapshotMessageIds,
                                                   LlmModelConfig modelConfig,
                                                   CompactionConfig config,
                                                   String currentUserQuestion,
                                                   AgentEventListener listener,
                                                   boolean compactCurrentTurn,
                                                   Integer measuredRequestTokens) {
        if (!config.isEnabled() || messages.isEmpty()) return null;

        if (compactCurrentTurn) {
            return compactSessionLoopMode(sessionId, expectedOldBoundary, existingSummary, messages,
                    snapshotMessageIds, modelConfig, config, currentUserQuestion, listener,
                    measuredRequestTokens);
        }
        return compactSessionRequestStart(sessionId, expectedOldBoundary, existingSummary, messages,
                snapshotMessageIds, modelConfig, config, currentUserQuestion, listener);
    }

    /** 请求开始压缩：行为与改造前逐行一致（不压当前 USER turn）。 */
    private SessionCompactionResult compactSessionRequestStart(
            Long sessionId, long expectedOldBoundary, String existingSummary,
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            LlmModelConfig modelConfig, CompactionConfig config,
            String currentUserQuestion, AgentEventListener listener) {
        long startTime = System.currentTimeMillis();

        List<List<PersistedChatMessage>> turns = splitUserTurns(messages);
        if (turns.size() < 2) return null;

        // The last USER turn is the request currently being executed and is never compacted.
        int completeTurnCount = turns.size() - 1;
        int retainedCompleteTurns = Math.min(Math.max(0, config.getRecentTurns()), completeTurnCount);
        int candidateTurnCount = completeTurnCount - retainedCompleteTurns;
        if (candidateTurnCount <= 0) return null;

        List<List<PersistedChatMessage>> candidateTurns = new ArrayList<>(
                turns.subList(0, candidateTurnCount));
        List<PersistedChatMessage> candidates = flatten(candidateTurns);
        List<ChatRequest.Message> candidateMessages = toChatMessages(candidates);
        List<ChatRequest.Message> allMessages = toChatMessages(messages);

        int candidateTokenCount = tokenEstimator.estimateMessages(candidateMessages);
        int totalTokenEstimate = tokenEstimator.estimateMessages(allMessages)
                + tokenEstimator.countTokens(existingSummary);

        int effectiveContextWindow = CompactionConfig.resolveEffectiveContextWindow(modelConfig, config);

        boolean shouldCompact = candidates.size() >= config.getMinNewMessageCount()
                && candidates.size() >= config.getMinCompactMessageCount()
                && totalTokenEstimate >= effectiveContextWindow * config.getTriggerRatio();

        if (!shouldCompact) return null;

        log.info("Session compaction triggered for session {}: {} messages ({} tokens) to compact, {} total tokens",
                sessionId, candidates.size(), candidateTokenCount, totalTokenEstimate);
        if (listener != null) {
            listener.onCompactionStart("session", candidates.size(), candidateTokenCount);
        }

        String rollingSummary = existingSummary;
        int totalCompacted = 0;
        int totalInputTokens = 0;
        int totalOutputTokens = 0;
        Set<Long> summarizedIds = new HashSet<>();

        SessionCompactionResult lastSafeResult = null;
        int turnIndex = 0;
        int rounds = 0;
        int borrowIndex = candidateTurnCount;
        int minBorrowIndex = Math.max(candidateTurnCount,
                completeTurnCount - Math.min(config.getMinRetainedTurns(), completeTurnCount));
        while (turnIndex < candidateTurns.size() && rounds < config.getMaxRoundsPerRequest()) {
            List<PersistedChatMessage> batch = takeNextBatch(candidateTurns, turnIndex, config);
            turnIndex += countUnitsInBatch(candidateTurns, turnIndex, batch);

            CompactionLlmResult llmResult = runCompactionRound(
                    rollingSummary, batch, currentUserQuestion, config, modelConfig, false);
            if (llmResult == null) {
                log.warn("Session compaction LLM call returned empty result for session {}", sessionId);
                break;
            }

            rollingSummary = llmResult.summaryText;
            totalCompacted += batch.size();
            totalInputTokens += llmResult.inputTokens;
            totalOutputTokens += llmResult.outputTokens;
            batch.stream().map(PersistedChatMessage::messageId).forEach(summarizedIds::add);
            rounds++;

            SessionCompactionResult safe = maybeBuildSafeResult(
                    messages, snapshotMessageIds, expectedOldBoundary, summarizedIds,
                    rollingSummary, totalCompacted, totalInputTokens, totalOutputTokens, startTime);
            if (safe != null) {
                lastSafeResult = safe;
            }

            if (turnIndex >= candidateTurns.size()) {
                if (borrowIndex >= minBorrowIndex) {
                    break;
                }
                int watermarkTokens = tokenEstimator.countTokens(rollingSummary)
                        + tokenEstimator.estimateMessages(
                                toChatMessages(flatten(new ArrayList<>(turns.subList(borrowIndex, turns.size())))));
                int targetTokens = (int) (effectiveContextWindow * config.getTargetRatio());
                if (watermarkTokens <= targetTokens) {
                    log.info("Session compaction reached target watermark {} <= {} tokens, stopping ({} rounds)",
                            watermarkTokens, targetTokens, rounds);
                    break;
                }
                List<PersistedChatMessage> borrowed = turns.get(borrowIndex);
                candidateTurns.add(borrowed);
                borrowIndex++;
                log.info("Session compaction watermark {} > target {}, borrowing 1 retained turn ({} messages, {} compacted total)",
                        watermarkTokens, targetTokens, borrowed.size(), totalCompacted);
            }
        }

        return finishSessionCompaction(sessionId, expectedOldBoundary, lastSafeResult,
                totalCompacted, listener, startTime);
    }

    /**
     * Loop 中途压缩：候选为连续前缀 unit（历史轮 → 当前 USER → 头部工具轮），
     * 门槛与水位基于完整请求 token 透传值。
     */
    private SessionCompactionResult compactSessionLoopMode(
            Long sessionId, long expectedOldBoundary, String existingSummary,
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            LlmModelConfig modelConfig, CompactionConfig config,
            String currentUserQuestion, AgentEventListener listener,
            Integer measuredRequestTokens) {
        if (measuredRequestTokens == null) return null;

        long startTime = System.currentTimeMillis();
        List<List<PersistedChatMessage>> turns = splitUserTurns(messages);
        List<List<PersistedChatMessage>> units = buildLoopUnits(turns, config);
        if (units.isEmpty()) return null;

        int effectiveContextWindow = CompactionConfig.resolveEffectiveContextWindow(modelConfig, config);
        if (measuredRequestTokens < effectiveContextWindow * config.getTriggerRatio()) {
            return null;
        }

        List<PersistedChatMessage> candidates = flatten(units);
        int candidateTokenCount = tokenEstimator.estimateMessages(toChatMessages(candidates));

        log.info("Session mid-loop compaction triggered for session {}: {} units / {} messages ({} tokens), requestTokens={}",
                sessionId, units.size(), candidates.size(), candidateTokenCount, measuredRequestTokens);
        if (listener != null) {
            listener.onCompactionStart("session", candidates.size(), candidateTokenCount);
        }

        String rollingSummary = existingSummary;
        int totalCompacted = 0;
        int totalInputTokens = 0;
        int totalOutputTokens = 0;
        Set<Long> summarizedIds = new HashSet<>();

        SessionCompactionResult lastSafeResult = null;
        int unitIndex = 0;
        int rounds = 0;
        int maxRounds = Math.max(1, config.getLoopMaxCompactionRounds());
        int targetTokens = (int) (effectiveContextWindow * config.getTargetRatio());

        while (unitIndex < units.size() && rounds < maxRounds) {
            List<PersistedChatMessage> batch = takeNextBatch(units, unitIndex, config);
            unitIndex += countUnitsInBatch(units, unitIndex, batch);

            CompactionLlmResult llmResult = runCompactionRound(
                    rollingSummary, batch, currentUserQuestion, config, modelConfig, true);
            if (llmResult == null) {
                log.warn("Session mid-loop compaction LLM call returned empty result for session {}", sessionId);
                break;
            }

            rollingSummary = llmResult.summaryText;
            totalCompacted += batch.size();
            totalInputTokens += llmResult.inputTokens;
            totalOutputTokens += llmResult.outputTokens;
            batch.stream().map(PersistedChatMessage::messageId).forEach(summarizedIds::add);
            rounds++;

            SessionCompactionResult safe = maybeBuildSafeResult(
                    messages, snapshotMessageIds, expectedOldBoundary, summarizedIds,
                    rollingSummary, totalCompacted, totalInputTokens, totalOutputTokens, startTime);
            if (safe != null) {
                lastSafeResult = safe;
            }

            // 水位：完整请求口径 = measured - 已摘要消息 tokens + 新摘要 tokens
            int summarizedMsgTokens = tokenEstimator.estimateMessages(
                    toChatMessages(messages.stream()
                            .filter(m -> summarizedIds.contains(m.messageId()))
                            .toList()));
            int watermark = measuredRequestTokens - summarizedMsgTokens
                    + tokenEstimator.countTokens(rollingSummary);
            if (watermark <= targetTokens) {
                log.info("Session mid-loop compaction reached target watermark {} <= {}, stopping ({} rounds)",
                        watermark, targetTokens, rounds);
                break;
            }
        }

        return finishSessionCompaction(sessionId, expectedOldBoundary, lastSafeResult,
                totalCompacted, listener, startTime);
    }

    /**
     * Loop 模式连续前缀候选：历史完整 turn 各为一个 unit；
     * 若当前 turn 可压工具轮非空，再追加 USER 头部 unit + 各可压工具轮 unit。
     */
    List<List<PersistedChatMessage>> buildLoopUnits(
            List<List<PersistedChatMessage>> turns, CompactionConfig config) {
        List<List<PersistedChatMessage>> units = new ArrayList<>();
        if (turns.isEmpty()) return units;

        List<List<PersistedChatMessage>> history;
        List<PersistedChatMessage> current;
        if (turns.size() == 1) {
            history = List.of();
            current = turns.get(0);
        } else {
            history = turns.subList(0, turns.size() - 1);
            current = turns.get(turns.size() - 1);
        }

        for (List<PersistedChatMessage> turn : history) {
            units.add(new ArrayList<>(turn));
        }

        ToolRoundSplit split = splitToolRounds(current);
        int keepRounds = Math.max(0, config.getLoopRecentToolRounds());
        List<List<PersistedChatMessage>> compactable;
        if (split.rounds().size() <= keepRounds) {
            compactable = List.of();
        } else {
            compactable = split.rounds().subList(0, split.rounds().size() - keepRounds);
        }

        if (!compactable.isEmpty()) {
            if (!split.header().isEmpty()) {
                units.add(new ArrayList<>(split.header()));
            }
            for (List<PersistedChatMessage> round : compactable) {
                units.add(new ArrayList<>(round));
            }
        }

        return units;
    }

    /**
     * 按 assistant 起始切工具轮；USER / 孤立 tool 归入 header。
     */
    ToolRoundSplit splitToolRounds(List<PersistedChatMessage> turn) {
        List<PersistedChatMessage> header = new ArrayList<>();
        List<List<PersistedChatMessage>> rounds = new ArrayList<>();
        List<PersistedChatMessage> currentRound = null;

        for (PersistedChatMessage message : turn) {
            String role = message.chatMessage().getRole();
            if ("assistant".equals(role)) {
                currentRound = new ArrayList<>();
                currentRound.add(message);
                rounds.add(currentRound);
            } else if ("tool".equals(role)) {
                if (currentRound != null) {
                    currentRound.add(message);
                } else {
                    header.add(message);
                }
            } else if (currentRound == null) {
                header.add(message);
            } else {
                // 不应出现在完整工具轮中间；保守归入 header 并断开当前轮归属
                header.add(message);
                currentRound = null;
            }
        }
        return new ToolRoundSplit(header, rounds);
    }

    private List<PersistedChatMessage> takeNextBatch(
            List<List<PersistedChatMessage>> units, int startIndex, CompactionConfig config) {
        List<PersistedChatMessage> batch = new ArrayList<>();
        int i = startIndex;
        do {
            List<PersistedChatMessage> nextUnit = units.get(i);
            if (!batch.isEmpty()
                    && batch.size() + nextUnit.size() > config.getMaxCompactionBatchMessages()) {
                break;
            }
            batch.addAll(nextUnit);
            i++;
        } while (i < units.size() && batch.size() < config.getMaxCompactionBatchMessages());
        return batch;
    }

    private int countUnitsInBatch(List<List<PersistedChatMessage>> units, int startIndex,
                                  List<PersistedChatMessage> batch) {
        int count = 0;
        int covered = 0;
        for (int i = startIndex; i < units.size() && covered < batch.size(); i++) {
            covered += units.get(i).size();
            count++;
        }
        return count;
    }

    private CompactionLlmResult runCompactionRound(
            String rollingSummary, List<PersistedChatMessage> batch,
            String currentUserQuestion, CompactionConfig config,
            LlmModelConfig modelConfig, boolean loopMode) {
        String formattedHistory = formatMessagesForCompaction(toChatMessages(batch));
        String compactionPrompt = buildSessionCompactionPrompt(
                rollingSummary, formattedHistory, currentUserQuestion,
                config.getMaxSummaryTokens(), loopMode);
        CompactionLlmResult llmResult = callCompactionModel(compactionPrompt, modelConfig);
        if (llmResult == null || llmResult.summaryText == null || llmResult.summaryText.isBlank()) {
            return null;
        }
        return llmResult;
    }

    private SessionCompactionResult maybeBuildSafeResult(
            List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
            long expectedOldBoundary, Set<Long> summarizedIds, String rollingSummary,
            int totalCompacted, int totalInputTokens, int totalOutputTokens, long startTime) {
        long candidateBoundary = summarizedIds.stream().mapToLong(Long::longValue).max().orElse(0L);
        if (!isCompletePhysicalPrefix(
                expectedOldBoundary, candidateBoundary, snapshotMessageIds, summarizedIds)) {
            return null;
        }
        String boundaryContentSnapshot = messages.stream()
                .filter(message -> message.messageId() == candidateBoundary)
                .findFirst()
                .map(PersistedChatMessage::persistedContentSnapshot)
                .orElse(null);
        int summaryTokens = tokenEstimator.countTokens(rollingSummary);
        int compactedTokens = tokenEstimator.estimateMessages(
                toChatMessages(messages.stream()
                        .filter(message -> summarizedIds.contains(message.messageId()))
                        .toList()));
        return new SessionCompactionResult(
                rollingSummary,
                expectedOldBoundary,
                candidateBoundary,
                boundaryContentSnapshot,
                totalCompacted,
                totalInputTokens,
                totalOutputTokens,
                summaryTokens,
                Math.max(0, compactedTokens - summaryTokens),
                System.currentTimeMillis() - startTime);
    }

    private SessionCompactionResult finishSessionCompaction(
            Long sessionId, long expectedOldBoundary, SessionCompactionResult lastSafeResult,
            int totalCompacted, AgentEventListener listener, long startTime) {
        if (lastSafeResult == null && totalCompacted > 0) {
            log.warn("Session compaction produced no safe physical ID prefix: sessionId={}, oldBoundary={}",
                    sessionId, expectedOldBoundary);
        } else if (lastSafeResult != null) {
            log.info("Session compaction generated for session {}: boundary {} -> {}, {} messages, ~{} tokens saved",
                    sessionId, expectedOldBoundary, lastSafeResult.newLastCompactedMessageId(),
                    lastSafeResult.compactedCount(), lastSafeResult.savedTokens());
        }
        if (listener != null) {
            listener.onCompactionEnd(
                    "session",
                    lastSafeResult != null ? lastSafeResult.summaryTokens() : 0,
                    lastSafeResult != null ? lastSafeResult.savedTokens() : 0,
                    System.currentTimeMillis() - startTime);
        }
        return lastSafeResult;
    }

    public List<ChatRequest.Message> prependSessionSummary(
            String summary, List<ChatRequest.Message> incrementalMessages) {
        List<ChatRequest.Message> result = new ArrayList<>();
        boolean hasSummary = summary != null && !summary.isBlank();
        if (hasSummary) {
            result.add(ChatRequest.Message.builder()
                    .role("system")
                    .content(buildSummaryInjectionPrompt(summary))
                    .build());
        }

        // 增量首条非 system 不是 user 时补合成 user（仅有摘要时），保证兼容网关序列合法
        if (hasSummary && needsSyntheticUser(incrementalMessages)) {
            result.add(ChatRequest.Message.builder()
                    .role("user")
                    .content(SYNTHETIC_CONTINUE_USER)
                    .build());
        }

        if (incrementalMessages != null) {
            result.addAll(incrementalMessages);
        }
        return result;
    }

    private boolean needsSyntheticUser(List<ChatRequest.Message> incrementalMessages) {
        if (incrementalMessages == null || incrementalMessages.isEmpty()) {
            return false;
        }
        for (ChatRequest.Message msg : incrementalMessages) {
            if ("system".equals(msg.getRole())) {
                continue;
            }
            return !"user".equals(msg.getRole());
        }
        return false;
    }

    List<List<PersistedChatMessage>> splitUserTurns(List<PersistedChatMessage> messages) {
        List<List<PersistedChatMessage>> turns = new ArrayList<>();
        List<PersistedChatMessage> current = null;
        for (PersistedChatMessage message : messages) {
            if ("user".equals(message.chatMessage().getRole())) {
                current = new ArrayList<>();
                turns.add(current);
            } else if (current == null) {
                // Boundary may land on a USER row; incremental history then starts with the
                // rest of that turn (assistant/tool) before the next USER message.
                current = new ArrayList<>();
                turns.add(current);
            }
            current.add(message);
        }
        return turns;
    }

    private List<PersistedChatMessage> flatten(List<List<PersistedChatMessage>> turns) {
        List<PersistedChatMessage> result = new ArrayList<>();
        turns.forEach(result::addAll);
        return result;
    }

    private List<ChatRequest.Message> toChatMessages(List<PersistedChatMessage> messages) {
        return messages.stream().map(PersistedChatMessage::chatMessage).toList();
    }

    private boolean isCompletePhysicalPrefix(long oldBoundary,
                                             long candidateBoundary,
                                             List<Long> snapshotMessageIds,
                                             Set<Long> summarizedIds) {
        if (candidateBoundary <= oldBoundary) {
            return false;
        }
        return snapshotMessageIds.stream()
                .filter(id -> id > oldBoundary && id <= candidateBoundary)
                .allMatch(summarizedIds::contains);
    }

    // ======================== 内部方法 ========================

    private String formatMessagesForCompaction(List<ChatRequest.Message> messages) {
        StringBuilder sb = new StringBuilder();
        for (ChatRequest.Message msg : messages) {
            String textContent = TokenEstimator.contentToString(msg.getContent());
            switch (msg.getRole()) {
                case "user" -> {
                    sb.append("用户: ").append(truncate(textContent, MAX_SINGLE_MESSAGE_CHARS)).append("\n\n");
                }
                case "assistant" -> {
                    if (textContent != null && !textContent.isEmpty()) {
                        sb.append("助手: ").append(truncate(textContent, MAX_SINGLE_MESSAGE_CHARS)).append("\n");
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
                            .append(truncate(formatToolResultForCompaction(textContent), MAX_TOOL_RESULT_CHARS))
                            .append("\n\n");
                }
                case "system" -> {
                    sb.append("[系统] ").append(truncate(textContent, MAX_SINGLE_MESSAGE_CHARS)).append("\n\n");
                }
            }
        }
        return sb.toString();
    }

    private String formatToolResultForCompaction(String textContent) {
        if (textContent == null || textContent.isBlank()) {
            return "";
        }
        try {
            var node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(textContent);
            if (cn.etarch.mao.harness.tool.ToolImageResultProcessor.isImageResult(node)) {
                return node.path("content").asText(textContent);
            }
            if (node.has("data_uri")) {
                return textContent.replaceAll("\"data_uri\"\\s*:\\s*\"[^\"]*\"", "\"data_uri\":\"[stripped]\"");
            }
        } catch (Exception ignored) {
        }
        return textContent;
    }

    private String truncate(String text, int maxChars) {
        if (text == null) return "";
        if (text.length() <= maxChars) return text;
        return text.substring(0, maxChars / 2) + "\n... [truncated] ...\n" + text.substring(text.length() - maxChars / 2);
    }

    private String buildSessionCompactionPrompt(String existingSummary, String history, String currentQuestion,
                                                int maxSummaryTokens, boolean loopMode) {
        StringBuilder sb = new StringBuilder();
        sb.append("你是一个会话压缩助手。你的任务是将以下对话历史压缩为一段简洁的摘要，以便 Agent 在后续执行中能延续任务。\n\n");
        sb.append("摘要要求：\n");
        sb.append("1. 保留用户明确请求和意图\n");
        sb.append("2. 保留关键技术概念、架构判断和决策\n");
        sb.append("3. 保留文件路径、接口、命令、错误、测试结果、版本号\n");
        sb.append("4. 保留已完成事项、未完成待办、当前停留位置\n");
        sb.append("5. 保留与当前请求最相关的下一步\n");
        sb.append("6. 不要泛泛总结，要保留可执行的具体信息\n");
        sb.append("7. 摘要尽量精炼，正文控制在约 ")
                .append(maxSummaryTokens)
                .append(" tokens 以内；在保留关键信息的前提下，删除冗余过程描述和重复内容\n");
        if (loopMode) {
            sb.append("8. 额外保留当前任务目标、已完成动作、关键发现、当前状态与下一步\n");
            sb.append("9. 必须将「当前用户问题」原文完整保留在摘要中，不得改写或省略"
                    + "（该用户消息本身将被摘要化，摘要是其唯一载体）\n");
        }
        sb.append("\n");

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

            String content = TokenEstimator.contentToString(response.getChoices().get(0).getMessage().getContent());
            if (content == null || content.isBlank()) return null;

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

    record ToolRoundSplit(List<PersistedChatMessage> header, List<List<PersistedChatMessage>> rounds) {}

    public record SessionCompactionResult(
            String summaryText,
            Long expectedOldBoundary,
            Long newLastCompactedMessageId,
            String boundaryContentSnapshot,
            int compactedCount,
            long inputTokens,
            long outputTokens,
            int summaryTokens,
            int savedTokens,
            long durationMs
    ) {}
}
