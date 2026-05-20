package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Agent 核心循环：Think → Act → Observe → 反馈
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentLoop {

    private final LlmAdapter llmAdapter;
    private final PromptEngine promptEngine;
    private final ContextManager contextManager;

    /**
     * 执行 Agent 循环
     */
    public void execute(AgentExecutionContext context, AgentEventListener listener) {
        int round = 0;
        int maxRounds = context.getMaxRounds();

        while (round < maxRounds) {
            round++;
            log.debug("Agent loop round {}/{}", round, maxRounds);

            // 1. 构建 Prompt
            ChatRequest request = promptEngine.buildRequest(context);

            // 2. 调用 LLM
            llmAdapter.stream(request, context.getModelConfig(), new StreamCallback() {
                private final StringBuilder contentBuilder = new StringBuilder();
                private final java.util.List<ChatRequest.ToolCall> toolCalls = new java.util.ArrayList<>();

                @Override
                public void onChunk(StreamChunk chunk) {
                    if (chunk.getChoices() == null || chunk.getChoices().isEmpty()) return;

                    StreamChunk.DeltaChoice choice = chunk.getChoices().get(0);
                    StreamChunk.Delta delta = choice.getDelta();

                    if (delta != null) {
                        // Handle content delta
                        if (delta.getContent() != null) {
                            contentBuilder.append(delta.getContent());
                            listener.onContentDelta(delta.getContent());
                        }

                        // Handle tool calls
                        if (delta.getToolCalls() != null) {
                            for (ChatRequest.ToolCall tc : delta.getToolCalls()) {
                                // Merge tool call deltas
                                mergeToolCall(toolCalls, tc);
                            }
                        }
                    }
                }

                @Override
                public void onComplete(ChatUsage usage) {
                    context.addUsage(usage);

                    if (!toolCalls.isEmpty()) {
                        // Tool calls detected - notify listener
                        for (ChatRequest.ToolCall tc : toolCalls) {
                            listener.onToolCallStart(tc);
                        }
                        // Store tool calls for execution
                        context.setPendingToolCalls(toolCalls);
                    }

                    // Store assistant message
                    String content = contentBuilder.toString();
                    if (!content.isEmpty() || !toolCalls.isEmpty()) {
                        context.addAssistantMessage(content, toolCalls);
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
                // No tool calls - conversation complete
                break;
            }

            // 4. Execute tool calls (to be implemented by SkillDispatcher/McpClient)
            // TODO: Execute tool calls and add results to context

            // 5. Clear pending calls for next round
            context.clearPendingToolCalls();
        }

        listener.onMessageEnd(context.getTotalUsage());
    }

    /**
     * Merge streaming tool call deltas
     */
    private void mergeToolCall(List<ChatRequest.ToolCall> existing, ChatRequest.ToolCall delta) {
        // Simple merge - in production, need proper index-based merging
        if (delta.getId() != null) {
            existing.add(delta);
        } else if (!existing.isEmpty()) {
            // Append to last tool call's arguments
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
