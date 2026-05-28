package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.*;
import com.agentworkbench.harness.tool.ToolDispatcher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
    private final ExecutorService toolExecutor = Executors.newCachedThreadPool();

    /** Per-session cancel flags: set to true to request cancellation */
    private final ConcurrentHashMap<Long, AtomicBoolean> cancelFlags = new ConcurrentHashMap<>();

    private static final int TODO_REMINDER_INTERVAL = 10;

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
        int maxRounds = context.getMaxRounds();
        int roundsSinceTodoUpdate = 0;

        try {
        while (round < maxRounds) {
            round++;
            log.debug("Agent loop round {}/{}", round, maxRounds);

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

            // 0.6. Todo nag reminder
            if (roundsSinceTodoUpdate >= TODO_REMINDER_INTERVAL) {
                context.addSystemMessage("<reminder>Please update your task plan using the todo tool.</reminder>");
                roundsSinceTodoUpdate = 0;
            }

            // 1. Build Prompt
            ChatRequest request = promptEngine.buildRequest(context);

            // 1.5. Emit estimated context window before LLM call
            int estimatedTokens = contextManager.estimateRequestTokens(request);
            int maxContextTokens = context.getModelConfig() != null && context.getModelConfig().getMaxTokens() != null
                    ? context.getModelConfig().getMaxTokens() : 0;
            listener.onContextWindow(estimatedTokens, 0, maxContextTokens);

            // 2. Call LLM
            final int currentRound = round;
            final AtomicBoolean llmFailed = new AtomicBoolean(false);
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
                            contentBuilder.append(delta.getContent());
                            listener.onContentDelta(delta.getContent());
                        }

                        if (delta.getToolCalls() != null) {
                            for (ChatRequest.ToolCall tc : delta.getToolCalls()) {
                                mergeToolCall(toolCalls, tc);
                            }
                        }
                    }
                }

                @Override
                public void onComplete(ChatUsage usage) {
                    context.addUsage(usage);
                    log.debug("LLM round {} complete: contentLength={}, toolCallCount={}, usage={}",
                            currentRound, contentBuilder.length(), toolCalls.size(), usage);

                    // Emit actual prompt_tokens from LLM response
                    if (usage != null && usage.getPromptTokens() > 0) {
                        listener.onContextWindow(estimatedTokens, usage.getPromptTokens(), maxContextTokens);
                    }

                    if (!toolCalls.isEmpty()) {
                        for (ChatRequest.ToolCall tc : toolCalls) {
                            listener.onToolCallStart(tc);
                        }
                        context.setPendingToolCalls(toolCalls);
                    }

                    String content = contentBuilder.toString();
                    if (!content.isEmpty() || !toolCalls.isEmpty()) {
                        context.addAssistantMessage(content, toolCalls);
                        if (persistenceCallback != null) {
                            persistenceCallback.onSaveAssistantMessage(content, toolCalls, usage);
                        }
                    }
                }

                @Override
                public void onError(Throwable t) {
                    llmFailed.set(true);
                    log.error("LLM call failed", t);
                    listener.onError(t);
                }
            });

            if (llmFailed.get()) {
                return;
            }

            // 3. Check if we have tool calls to execute
            List<ChatRequest.ToolCall> pendingCalls = context.getPendingToolCalls();
            if (pendingCalls == null || pendingCalls.isEmpty()) {
                break;
            }

            // 4. Execute tool calls in parallel
            boolean calledTodo = executeToolCalls(pendingCalls, context, listener, persistenceCallback);

            // Track todo usage for nag reminder
            if (calledTodo) {
                roundsSinceTodoUpdate = 0;
            } else {
                roundsSinceTodoUpdate++;
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
            }
        }
    }

    /**
     * Execute tool calls in parallel using CompletableFuture.
     * Returns true if any tool call was to the "todo" skill.
     */
    private boolean executeToolCalls(List<ChatRequest.ToolCall> pendingCalls,
                                     AgentExecutionContext context,
                                     AgentEventListener listener,
                                     MessagePersistenceCallback persistenceCallback) {
        boolean calledTodo = false;

        if (pendingCalls.size() == 1) {
            // Single tool call - execute directly without async overhead
            ChatRequest.ToolCall tc = pendingCalls.get(0);
            String toolName = tc.getFunction().getName();
            if ("todo".equals(toolName)) calledTodo = true;
            String result = dispatchTool(toolName, tc.getFunction().getArguments(), context);
            context.addToolResult(tc.getId(), result);
            listener.onToolCallResult(tc.getId(), result);
            if (persistenceCallback != null) {
                persistenceCallback.onSaveToolMessage(tc.getId(), result);
            }
        } else {
            // Multiple tool calls - execute in parallel
            List<CompletableFuture<Void>> futures = new ArrayList<>();
            String[] results = new String[pendingCalls.size()];

            for (int i = 0; i < pendingCalls.size(); i++) {
                final int index = i;
                ChatRequest.ToolCall tc = pendingCalls.get(i);
                String toolName = tc.getFunction().getName();
                if ("todo".equals(toolName)) calledTodo = true;

                futures.add(CompletableFuture.runAsync(() -> {
                    results[index] = dispatchTool(toolName, tc.getFunction().getArguments(), context);
                }, toolExecutor));
            }

            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();

            // Collect results in order
            for (int i = 0; i < pendingCalls.size(); i++) {
                ChatRequest.ToolCall tc = pendingCalls.get(i);
                context.addToolResult(tc.getId(), results[i]);
                listener.onToolCallResult(tc.getId(), results[i]);
                if (persistenceCallback != null) {
                    persistenceCallback.onSaveToolMessage(tc.getId(), results[i]);
                }
            }
        }

        return calledTodo;
    }

    private String dispatchTool(String toolName, String arguments, AgentExecutionContext context) {
        try {
            return toolDispatcher.dispatch(toolName, arguments, context.getExecutionMode(), context.getSessionId(), context.getWorkspace());
        } catch (Exception e) {
            return "Tool execution failed: " + e.getMessage();
        }
    }

    private void mergeToolCall(List<ChatRequest.ToolCall> existing, ChatRequest.ToolCall delta) {
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
    }
}
