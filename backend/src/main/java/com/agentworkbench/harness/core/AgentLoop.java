package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.*;
import com.agentworkbench.harness.shell.ShellSessionManager;
import com.agentworkbench.harness.tool.ToolDispatcher;
import com.agentworkbench.session.util.ToolResultSummarizer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;



@Slf4j
@Component
@RequiredArgsConstructor
public class AgentLoop {

    private final LlmAdapter llmAdapter;
    private final PromptEngine promptEngine;
    private final ContextManager contextManager;
    private final ToolDispatcher toolDispatcher;
    private final BackgroundTaskManager backgroundTaskManager;
    private final ShellSessionManager shellSessionManager;
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
        void onSaveAssistantMessage(String content, List<ChatRequest.ToolCall> toolCalls, ChatUsage usage);
        void onSaveToolMessage(String toolCallId, String content);
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
        final ChatUsage[] pendingSaveUsage = {null};
        final List<ChatRequest.ToolCall>[] pendingSaveToolCalls = new List[1];

        while (true) {
            round++;
            log.debug("Agent loop round {}", round);

            // Check cancellation
            Long sessionId = context.getSessionId();
            if (sessionId != null) {
                AtomicBoolean cancelFlag = cancelFlags.get(sessionId);
                if (cancelFlag != null && cancelFlag.get()) {
                    log.info("Agent loop cancelled for session {}", sessionId);
                    return;
                }
            }

            // 0.5. Inject completed background task results
            Map<String, String> bgResults = backgroundTaskManager.consumeCompletedResults();
            if (!bgResults.isEmpty()) {
                StringBuilder sb = new StringBuilder("<background-task-results>\n");
                bgResults.forEach((taskId, result) ->
                        sb.append("Task ").append(taskId).append(": ").append(result).append("\n"));
                sb.append("</background-task-results>");
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
            llmAdapter.stream(request, context.getModelConfig(), new StreamCallback() {
                private final StringBuilder contentBuilder = new StringBuilder();
                private final List<ChatRequest.ToolCall> toolCalls = new ArrayList<>();

                @Override
                public void onChunk(StreamChunk chunk) {
                    if (chunk.getChoices() == null || chunk.getChoices().isEmpty()) return;

                    StreamChunk.DeltaChoice choice = chunk.getChoices().get(0);
                    StreamChunk.Delta delta = choice.getDelta();

                    if (delta != null) {
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
                    if (!content.isEmpty() || !toolCalls.isEmpty()) {
                        context.addAssistantMessage(content, toolCalls);
                        if (toolCalls.isEmpty() && persistenceCallback != null) {
                            persistenceCallback.onSaveAssistantMessage(content, toolCalls, usage);
                        } else {
                            pendingSave[0] = content;
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
            });

            // 3. Check if we have tool calls to execute
            List<ChatRequest.ToolCall> pendingCalls = context.getPendingToolCalls();
            if (pendingCalls == null || pendingCalls.isEmpty()) {
                break;
            }

            // 4. Execute tool calls in parallel (summary 已附加到 ToolCall)
            executeToolCalls(pendingCalls, context, listener, persistenceCallback);

            // 4.1 延迟保存带 summary 的 assistant 消息
            if (pendingSaveToolCalls[0] != null && persistenceCallback != null) {
                persistenceCallback.onSaveAssistantMessage(pendingSave[0], pendingSaveToolCalls[0], pendingSaveUsage[0]);
                pendingSave[0] = null;
                pendingSaveUsage[0] = null;
                pendingSaveToolCalls[0] = null;
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

    /**
     * Execute tool calls in parallel using CompletableFuture.
     */
    private void executeToolCalls(List<ChatRequest.ToolCall> pendingCalls,
                                  AgentExecutionContext context,
                                  AgentEventListener listener,
                                  MessagePersistenceCallback persistenceCallback) {
        if (pendingCalls.size() == 1) {
            ChatRequest.ToolCall tc = pendingCalls.get(0);
            String result = dispatchTool(tc.getFunction().getName(), tc.getFunction().getArguments(), context);
            tc.setSummary(ToolResultSummarizer.summarize(
                    tc.getFunction().getName(), tc.getFunction().getArguments(), result));
            context.addToolResult(tc.getId(), result);
            listener.onToolCallResult(tc.getId(), result);
            if (persistenceCallback != null) {
                persistenceCallback.onSaveToolMessage(tc.getId(), result);
            }
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

            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();

            for (int i = 0; i < pendingCalls.size(); i++) {
                ChatRequest.ToolCall tc = pendingCalls.get(i);
                tc.setSummary(ToolResultSummarizer.summarize(
                        tc.getFunction().getName(), tc.getFunction().getArguments(), results[i]));
                context.addToolResult(tc.getId(), results[i]);
                listener.onToolCallResult(tc.getId(), results[i]);
                if (persistenceCallback != null) {
                    persistenceCallback.onSaveToolMessage(tc.getId(), results[i]);
                }
            }
        }
    }

    private String dispatchTool(String toolName, String arguments, AgentExecutionContext context) {
        try {
            return toolDispatcher.dispatch(toolName, arguments,
                    context.getExecutionMode(), context.getSessionId(), context.getWorkspace(),
                    context.getPermissionLevel(), context.getModelConfig());
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
