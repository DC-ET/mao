package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.*;
import com.agentworkbench.harness.skill.SkillDispatcher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;



@Slf4j
@Component
@RequiredArgsConstructor
public class AgentLoop {

    private final LlmAdapter llmAdapter;
    private final PromptEngine promptEngine;
    private final ContextManager contextManager;
    private final SkillDispatcher skillDispatcher;
    private final BackgroundTaskManager backgroundTaskManager;
    private final ExecutorService toolExecutor = Executors.newCachedThreadPool();

    private static final int TODO_REMINDER_INTERVAL = 3;

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

        while (round < maxRounds) {
            round++;
            log.debug("Agent loop round {}/{}", round, maxRounds);

            // 0. Compress context if needed
            int maxTokens = context.getModelConfig() != null && context.getModelConfig().getMaxTokens() != null
                    ? context.getModelConfig().getMaxTokens() : 0;
            if (contextManager.needsCompression(context, maxTokens)) {
                // Micro-compact first: replace old tool results with placeholders
                contextManager.microCompact(context, TODO_REMINDER_INTERVAL);
                // Then auto-compress if still over limit
                if (contextManager.needsCompression(context, maxTokens)) {
                    List<ChatRequest.Message> compressed = contextManager.compress(context, 0);
                    context.setMessages(compressed);
                    listener.onContextCompressed(compressed.size());
                    log.info("Context compressed to {} messages before round {}", compressed.size(), round);
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

            // 2. Call LLM
            final int currentRound = round;
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
                    log.error("LLM call failed", t);
                    listener.onError(t);
                }
            });

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
        }

        listener.onMessageEnd(context.getTotalUsage());
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
            String result = dispatchTool(toolName, tc.getFunction().getArguments());
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
                    results[index] = dispatchTool(toolName, tc.getFunction().getArguments());
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

    private String dispatchTool(String toolName, String arguments) {
        try {
            return skillDispatcher.dispatch(toolName, arguments);
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
