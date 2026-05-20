package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.*;
import com.agentworkbench.harness.skill.SkillDispatcher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

@Slf4j
@Component
@RequiredArgsConstructor
public class AgentLoop {

    private final LlmAdapter llmAdapter;
    private final PromptEngine promptEngine;
    private final ContextManager contextManager;
    private final SkillDispatcher skillDispatcher;

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

        while (round < maxRounds) {
            round++;
            log.debug("Agent loop round {}/{}", round, maxRounds);

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

                    if (!toolCalls.isEmpty()) {
                        for (ChatRequest.ToolCall tc : toolCalls) {
                            listener.onToolCallStart(tc);
                        }
                        context.setPendingToolCalls(toolCalls);
                    }

                    String content = contentBuilder.toString();
                    if (!content.isEmpty() || !toolCalls.isEmpty()) {
                        context.addAssistantMessage(content, toolCalls);
                        // Persist assistant message
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

            // 4. Execute tool calls via SkillDispatcher
            for (ChatRequest.ToolCall tc : pendingCalls) {
                String toolName = tc.getFunction().getName();
                String arguments = tc.getFunction().getArguments();
                try {
                    String result = skillDispatcher.dispatch(toolName, arguments);
                    context.addToolResult(tc.getId(), result);
                    listener.onToolCallResult(tc.getId(), result);
                    if (persistenceCallback != null) {
                        persistenceCallback.onSaveToolMessage(tc.getId(), result);
                    }
                } catch (Exception e) {
                    String errorResult = "Tool execution failed: " + e.getMessage();
                    context.addToolResult(tc.getId(), errorResult);
                    listener.onToolCallResult(tc.getId(), errorResult);
                    if (persistenceCallback != null) {
                        persistenceCallback.onSaveToolMessage(tc.getId(), errorResult);
                    }
                }
            }

            // 5. Clear pending calls for next round
            context.clearPendingToolCalls();
        }

        listener.onMessageEnd(context.getTotalUsage());
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
