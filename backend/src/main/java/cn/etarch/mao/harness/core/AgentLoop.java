package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.*;
import cn.etarch.mao.harness.shell.ShellSessionManager;
import cn.etarch.mao.harness.tool.FileChangeDiffUtil;
import cn.etarch.mao.harness.tool.ToolDispatcher;
import cn.etarch.mao.session.activity.SessionActivityHeartbeat;
import cn.etarch.mao.session.util.ToolResultSummarizer;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;



@Slf4j
@Component
@RequiredArgsConstructor
public class AgentLoop {

    private final LlmAdapter llmAdapter;
    private final PromptEngine promptEngine;
    private final ContextManager contextManager;
    private final ToolDispatcher toolDispatcher;
    private final ObjectMapper objectMapper;
    private final BackgroundTaskManager backgroundTaskManager;
    private final ShellSessionManager shellSessionManager;
    private final SessionActivityHeartbeat activityHeartbeat;
    private final ExecutorService toolExecutor = Executors.newCachedThreadPool();

    /** Per-session cancel flags: set to true to request cancellation */
    private final ConcurrentHashMap<Long, AtomicBoolean> cancelFlags = new ConcurrentHashMap<>();


    /**
     * Register a cancel flag for a session. Call before execute().
     * Set the returned flag to true to request cancellation.
     */
    public AtomicBoolean registerCancelFlag(Long sessionId) {
        AtomicBoolean flag = new AtomicBoolean(false);
        cancelFlags.put(sessionId, flag);
        return flag;
    }

    /** Remove cancel flag after execution completes. */
    public void removeCancelFlag(Long sessionId) {
        cancelFlags.remove(sessionId);
    }

    public interface MessagePersistenceCallback {
        void onSaveAssistantMessage(String content, String thinkingContent, List<ChatRequest.ToolCall> toolCalls, ChatUsage usage);
        void onSaveToolMessage(String toolCallId, String content);

        default void onSaveAssistantMessage(String content, String thinkingContent,
                                             List<ChatRequest.ToolCall> toolCalls,
                                             Map<String, String> toolResults, ChatUsage usage) {
            onSaveAssistantMessage(content, thinkingContent, toolCalls, usage);
        }
    }

    public void execute(AgentExecutionContext context, AgentEventListener listener) {
        execute(context, listener, null);
    }

    public void execute(AgentExecutionContext context, AgentEventListener listener,
                        MessagePersistenceCallback persistenceCallback) {
        int round = 0;

        try {
        // 用于延迟保存：有工具调用时，在 executeToolCalls 之后再保存（summary 已附加）
        final String[] pendingSave = {null}; // [0]=content
        final String[] pendingThinking = {null}; // [0]=thinkingContent
        final ChatUsage[] pendingSaveUsage = {null};
        @SuppressWarnings("unchecked")
        final List<ChatRequest.ToolCall>[] pendingSaveToolCalls = new List[1];


        while (true) {
            round++;
            context.setCurrentRound(round);
            log.debug("Agent loop round {}", round);

            // Check cancellation
            Long sessionId = context.getSessionId();
            activityHeartbeat.touch(sessionId);
            AtomicBoolean cancelFlag = sessionId != null ? cancelFlags.get(sessionId) : null;
            if (cancelFlag != null && cancelFlag.get()) {
                log.info("Agent loop cancelled for session {}", sessionId);
                return;
            }

            // 0.5. Inject completed background task results
            Map<String, String> bgResults = backgroundTaskManager.consumeCompletedResults();
            if (!bgResults.isEmpty()) {
                StringBuilder sb = new StringBuilder("<后台任务结果>\n");
                bgResults.forEach((taskId, result) ->
                        sb.append("任务 ").append(taskId).append("：").append(result).append("\n"));
                sb.append("</后台任务结果>");
                context.addSystemMessage(sb.toString());
                log.info("Injected {} background task results", bgResults.size());
            }

            // 1. Build Prompt
            ChatRequest request = promptEngine.buildRequest(context);

            // 1.5. Emit estimated context window before LLM call
            int estimatedTokens = contextManager.estimateRequestTokens(request);
            listener.onContextWindow(estimatedTokens, 0);

            // 2. Call LLM
            final int currentRound = round;
            final AtomicBoolean thinkingEnded = new AtomicBoolean(false);
            final Set<String> emittedEarlyStarts = new HashSet<>();
            listener.onThinkingStart();
            try {
            llmAdapter.stream(request, context.getModelConfig(), new StreamCallback() {
                private final StringBuilder contentBuilder = new StringBuilder();
                private final StringBuilder thinkingBuilder = new StringBuilder();
                private final List<ChatRequest.ToolCall> toolCalls = new ArrayList<>();

                @Override
                public void onChunk(StreamChunk chunk) {
                    if (chunk.getChoices() == null || chunk.getChoices().isEmpty()) return;

                    StreamChunk.DeltaChoice choice = chunk.getChoices().get(0);
                    StreamChunk.Delta delta = choice.getDelta();

                    if (delta != null) {
                        if (delta.getReasoningContent() != null) {
                            thinkingBuilder.append(delta.getReasoningContent());
                            listener.onThinkingDelta(delta.getReasoningContent());
                        }

                        if (delta.getContent() != null) {
                            if (thinkingEnded.compareAndSet(false, true)) {
                                listener.onThinkingEnd();
                            }
                            contentBuilder.append(delta.getContent());
                            listener.onContentDelta(delta.getContent());
                        }

                        if (delta.getToolCalls() != null) {
                            for (ChatRequest.ToolCall tc : delta.getToolCalls()) {
                                ChatRequest.ToolCall merged = mergeToolCall(toolCalls, tc, listener, emittedEarlyStarts);
                                // 推送当前已累积的完整 arguments
                                if (merged != null && merged.getId() != null && merged.getFunction() != null) {
                                    String currentArgs = merged.getFunction().getArguments() != null
                                            ? merged.getFunction().getArguments() : "";
                                    listener.onToolCallArgsDelta(merged.getId(), currentArgs);
                                }
                            }
                        }
                    }
                }

                @Override
                public void onComplete(ChatUsage usage) {
                    if (thinkingEnded.compareAndSet(false, true)) {
                        listener.onThinkingEnd();
                    }
                    context.addUsage(usage);
                    log.debug("LLM round {} complete: contentLength={}, toolCallCount={}, usage={}",
                            currentRound, contentBuilder.length(), toolCalls.size(), usage);

                    // Emit actual prompt_tokens from LLM response
                    if (usage != null && usage.getPromptTokens() > 0) {
                        listener.onContextWindow(estimatedTokens, usage.getPromptTokens());
                    }

                    if (!toolCalls.isEmpty()) {
                        for (ChatRequest.ToolCall tc : toolCalls) {
                            // 更新 toolCallInfo 中的完整 arguments（mergeToolCall 阶段可能只有部分 args）
                            listener.onToolCallStart(tc);
                        }
                        context.setPendingToolCalls(toolCalls);
                    }

                    String content = contentBuilder.toString();
                    String thinkingContent = thinkingBuilder.length() > 0 ? thinkingBuilder.toString() : null;
                    if (!content.isEmpty() || !toolCalls.isEmpty()) {
                        context.addAssistantMessage(content, toolCalls);
                        if (toolCalls.isEmpty() && persistenceCallback != null) {
                            persistenceCallback.onSaveAssistantMessage(content, thinkingContent, toolCalls, usage);
                        } else {
                            pendingSave[0] = content;
                            pendingThinking[0] = thinkingContent;
                            pendingSaveUsage[0] = usage;
                            pendingSaveToolCalls[0] = toolCalls;
                        }
                    }
                }

                @Override
                public void onError(Throwable t) {
                    log.error("LLM call failed", t);
                    throw new RuntimeException("LLM call failed: " + t.getMessage(), t);
                }
            }, cancelFlag);
            } catch (RuntimeException e) {
                if (e.getMessage() != null && e.getMessage().contains("Cancelled by user")) {
                    if (thinkingEnded.compareAndSet(false, true)) {
                        listener.onThinkingEnd();
                    }
                    log.info("Agent loop round {} cancelled by user for session {}", currentRound, sessionId);
                    break;
                }
                throw e;
            }

            // 3. Check if we have tool calls to execute
            List<ChatRequest.ToolCall> pendingCalls = context.getPendingToolCalls();
            if (pendingCalls == null || pendingCalls.isEmpty()) {
                break;
            }

            // 4. Execute tool calls in parallel (summary 已附加到 ToolCall)
            Map<String, String> toolResults = new LinkedHashMap<>();
            List<ToolMessageSave> pendingToolSaves = new ArrayList<>();
            executeToolCalls(pendingCalls, context, listener, pendingToolSaves, toolResults, cancelFlag);
            activityHeartbeat.touch(context.getSessionId());

            // 用户中断工具执行时，不持久化不完整的 assistant+tool_calls 轮次，避免下次 LLM 调用 400
            if (cancelFlag != null && cancelFlag.get()) {
                rollbackIncompleteRound(context, pendingSaveToolCalls[0]);
                pendingSave[0] = null;
                pendingThinking[0] = null;
                pendingSaveUsage[0] = null;
                pendingSaveToolCalls[0] = null;
                context.clearPendingToolCalls();
                break;
            }

            // 4.1 先保存 assistant，再保存 tool 结果，保证 DB 顺序满足 LLM API 要求
            if (pendingSaveToolCalls[0] != null && persistenceCallback != null) {
                persistenceCallback.onSaveAssistantMessage(pendingSave[0], pendingThinking[0],
                        pendingSaveToolCalls[0], toolResults, pendingSaveUsage[0]);
                for (ToolMessageSave toolSave : pendingToolSaves) {
                    persistenceCallback.onSaveToolMessage(toolSave.toolCallId(), toolSave.content());
                }
                pendingSave[0] = null;
                pendingThinking[0] = null;
                pendingSaveUsage[0] = null;
                pendingSaveToolCalls[0] = null;
            } else if (!pendingToolSaves.isEmpty() && persistenceCallback != null) {
                for (ToolMessageSave toolSave : pendingToolSaves) {
                    persistenceCallback.onSaveToolMessage(toolSave.toolCallId(), toolSave.content());
                }
            }

            // 5. Clear pending calls for next round
            context.clearPendingToolCalls();

            // 6. Loop compaction — compress working memory if tool loop is growing
            CompactionConfig loopConfig = context.getCompactionConfig();
            if (loopConfig != null && loopConfig.isLoopEnabled()) {
                try {
                    var loopResult = contextManager.compactLoop(
                            context.getMessages(), context.getModelConfig(), loopConfig,
                            context.getWorkingSummary());
                    if (loopResult != null) {
                        context.getMessages().clear();
                        context.getMessages().addAll(loopResult.compactedMessages());
                        context.setWorkingSummary(loopResult.summaryText());
                        log.info("Loop compaction applied: {} messages compacted, ~{} tokens saved",
                                loopResult.compactedCount(), loopResult.savedTokens());
                    }
                } catch (Exception e) {
                    log.warn("Loop compaction failed, continuing with full history", e);
                }
            }
        }

        listener.onMessageEnd(context.getTotalUsage());
        } finally {
            Long sessionId = context.getSessionId();
            if (sessionId != null) {
                cancelFlags.remove(sessionId);
                // 清理该对话的所有 Shell 会话
                shellSessionManager.closeByConversation(sessionId);
            }
        }
    }

    private record ToolMessageSave(String toolCallId, String content) {}

    /**
     * 回滚当前轮次写入内存的 assistant+tool 消息（用户中断时尚未持久化）。
     */
    private void rollbackIncompleteRound(AgentExecutionContext context,
                                         List<ChatRequest.ToolCall> toolCalls) {
        if (toolCalls == null || toolCalls.isEmpty()) {
            return;
        }
        Set<String> toolCallIds = new HashSet<>();
        for (ChatRequest.ToolCall tc : toolCalls) {
            if (tc.getId() != null) {
                toolCallIds.add(tc.getId());
            }
        }
        List<ChatRequest.Message> messages = context.getMessages();
        messages.removeIf(m -> "tool".equals(m.getRole())
                && m.getToolCallId() != null
                && toolCallIds.contains(m.getToolCallId()));
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatRequest.Message msg = messages.get(i);
            if ("assistant".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
                messages.remove(i);
                break;
            }
        }
    }

    /**
     * Execute tool calls in parallel using CompletableFuture.
     * 期间检查 cancelFlag，支持用户中断。
     */
    private void executeToolCalls(List<ChatRequest.ToolCall> pendingCalls,
                                  AgentExecutionContext context,
                                  AgentEventListener listener,
                                  List<ToolMessageSave> pendingToolSaves,
                                  Map<String, String> toolResults,
                                  AtomicBoolean cancelFlag) {
        if (pendingCalls.size() == 1) {
            // 检查取消标志
            if (cancelFlag != null && cancelFlag.get()) return;
            ChatRequest.ToolCall tc = pendingCalls.get(0);
            String rawResult = dispatchTool(tc.getFunction().getName(), tc.getFunction().getArguments(), context);
            String sanitizedResult = sanitizeToolResult(rawResult);
            if (cancelFlag != null && cancelFlag.get()) return;
            tc.setSummary(ToolResultSummarizer.summarize(
                    tc.getFunction().getName(), tc.getFunction().getArguments(), sanitizedResult));
            toolResults.put(tc.getId(), rawResult);
            context.addToolResult(tc.getId(), sanitizedResult);
            listener.onToolCallResult(tc.getId(), rawResult);
            pendingToolSaves.add(new ToolMessageSave(tc.getId(), sanitizedResult));
        } else {
            List<CompletableFuture<Void>> futures = new ArrayList<>();
            String[] results = new String[pendingCalls.size()];

            for (int i = 0; i < pendingCalls.size(); i++) {
                final int index = i;
                ChatRequest.ToolCall tc = pendingCalls.get(i);
                futures.add(CompletableFuture.runAsync(() -> {
                    results[index] = dispatchTool(tc.getFunction().getName(), tc.getFunction().getArguments(), context);
                }, toolExecutor));
            }

            // 轮询等待所有工具完成，期间检查取消标志
            CompletableFuture<?> all = CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]));
            while (!all.isDone()) {
                if (cancelFlag != null && cancelFlag.get()) {
                    futures.forEach(f -> f.cancel(true));
                    log.info("Tool execution cancelled for session {}", context.getSessionId());
                    return;
                }
                try {
                    all.get(500, TimeUnit.MILLISECONDS);
                } catch (java.util.concurrent.TimeoutException e) {
                    // 超时 == 仍在执行，继续轮询
                } catch (Exception e) {
                    break;
                }
            }

            for (int i = 0; i < pendingCalls.size(); i++) {
                ChatRequest.ToolCall tc = pendingCalls.get(i);
                String rawResult = results[i];
                String sanitizedResult = sanitizeToolResult(rawResult);
                tc.setSummary(ToolResultSummarizer.summarize(
                        tc.getFunction().getName(), tc.getFunction().getArguments(), sanitizedResult));
                toolResults.put(tc.getId(), rawResult);
                context.addToolResult(tc.getId(), sanitizedResult);
                listener.onToolCallResult(tc.getId(), rawResult);
                pendingToolSaves.add(new ToolMessageSave(tc.getId(), sanitizedResult));
            }
        }
    }

    private String sanitizeToolResult(String result) {
        return FileChangeDiffUtil.stripPrivateDiff(result, objectMapper);
    }

    private String dispatchTool(String toolName, String arguments, AgentExecutionContext context) {
        try {
            return toolDispatcher.dispatch(toolName, arguments,
                    context.getExecutionMode(), context.getSessionId(), context.getUserId(),
                    context.getWorkspace(), context.getPermissionLevel(), context.getModelConfig());
        } catch (Exception e) {
            return "Tool execution failed: " + e.getMessage();
        }
    }

    /**
     * 合并工具调用增量，并在 id+name 首次可识别时立即回调 onToolCallStart。
     * @return 合并后的 ToolCall（用于推送 args delta）
     */
    private ChatRequest.ToolCall mergeToolCall(List<ChatRequest.ToolCall> existing, ChatRequest.ToolCall delta,
                                                AgentEventListener listener, Set<String> emittedEarlyStarts) {
        if (delta.getId() != null) {
            existing.add(delta);
        } else if (!existing.isEmpty()) {
            ChatRequest.ToolCall last = existing.get(existing.size() - 1);
            if (last.getFunction() == null) {
                last.setFunction(ChatRequest.FunctionCall.builder()
                        .name("")
                        .arguments("")
                        .build());
            }
            if (delta.getFunction() != null) {
                if (delta.getFunction().getName() != null) {
                    last.getFunction().setName(
                            last.getFunction().getName() + delta.getFunction().getName());
                }
                if (delta.getFunction().getArguments() != null) {
                    last.getFunction().setArguments(
                            last.getFunction().getArguments() + delta.getFunction().getArguments());
                }
            }
        }

        // 检测：合并后 id + name 首次同时具备，立即推送 tool_call_start
        ChatRequest.ToolCall merged = !existing.isEmpty() ? existing.get(existing.size() - 1) : null;
        if (merged != null && merged.getId() != null && !merged.getId().isEmpty()
                && merged.getFunction() != null && merged.getFunction().getName() != null
                && !merged.getFunction().getName().isEmpty()
                && emittedEarlyStarts.add(merged.getId())) {
            listener.onToolCallStart(merged);
        }

        return merged;
    }
}
