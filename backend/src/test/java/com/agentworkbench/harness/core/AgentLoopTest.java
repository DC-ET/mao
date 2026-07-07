package com.agentworkbench.harness.core;

import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.llm.LlmAdapter;
import com.agentworkbench.harness.llm.StreamCallback;
import com.agentworkbench.harness.llm.StreamChunk;
import com.agentworkbench.harness.shell.ShellSessionManager;
import com.agentworkbench.harness.tool.ToolDispatcher;
import com.agentworkbench.session.activity.SessionActivityHeartbeat;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AgentLoopTest {

    private final LlmAdapter llmAdapter = mock(LlmAdapter.class);
    private final PromptEngine promptEngine = mock(PromptEngine.class);
    private final ContextManager contextManager = mock(ContextManager.class);
    private final ToolDispatcher toolDispatcher = mock(ToolDispatcher.class);
    private final BackgroundTaskManager backgroundTaskManager = mock(BackgroundTaskManager.class);
    private final ShellSessionManager shellSessionManager = mock(ShellSessionManager.class);
    private final SessionActivityHeartbeat activityHeartbeat = mock(SessionActivityHeartbeat.class);
    private final AgentLoop agentLoop = new AgentLoop(
            llmAdapter, promptEngine, contextManager, toolDispatcher, new ObjectMapper(),
            backgroundTaskManager, shellSessionManager, activityHeartbeat);

    @Test
    void executeStreamsPlainAssistantMessageAndPersistsIt() {
        AgentExecutionContext context = context();
        AgentEventListener listener = mock(AgentEventListener.class);
        AgentLoop.MessagePersistenceCallback persistence = mock(AgentLoop.MessagePersistenceCallback.class);
        when(promptEngine.buildRequest(context)).thenReturn(ChatRequest.builder().messages(List.of()).stream(true).build());
        when(contextManager.estimateRequestTokens(any())).thenReturn(42);
        when(backgroundTaskManager.consumeCompletedResults()).thenReturn(Map.of("task-1", "done"), Map.of());
        doAnswer(invocation -> {
            StreamCallback callback = invocation.getArgument(2);
            callback.onChunk(contentChunk("thinking", null));
            callback.onChunk(contentChunk(null, "hello"));
            callback.onComplete(ChatUsage.builder().promptTokens(10).completionTokens(2).totalTokens(12).build());
            return null;
        }).when(llmAdapter).stream(any(), any(), any(), any());

        agentLoop.execute(context, listener, persistence);

        assertThat(context.getMessages()).extracting(ChatRequest.Message::getRole)
                .contains("system", "assistant");
        verify(listener).onThinkingDelta("thinking");
        verify(listener).onContentDelta("hello");
        verify(listener).onMessageEnd(any(ChatUsage.class));
        verify(persistence).onSaveAssistantMessage(eq("hello"), eq("thinking"), eq(List.of()), any(ChatUsage.class));
        verify(shellSessionManager).closeByConversation(11L);
    }

    @Test
    void executeRunsToolCallThenContinuesToSynthesisRound() {
        AgentExecutionContext context = context();
        AgentEventListener listener = mock(AgentEventListener.class);
        AgentLoop.MessagePersistenceCallback persistence = mock(AgentLoop.MessagePersistenceCallback.class);
        when(promptEngine.buildRequest(context)).thenReturn(ChatRequest.builder().messages(List.of()).stream(true).build());
        when(contextManager.estimateRequestTokens(any())).thenReturn(5);
        when(backgroundTaskManager.consumeCompletedResults()).thenReturn(Map.of());
        when(toolDispatcher.dispatch(eq("read_file"), anyString(), eq("CLOUD"), eq(11L), eq(7L),
                eq("/repo"), eq("READ_ONLY"), any())).thenReturn("{\"ok\":true,\"_private_diff\":{\"diff_mode\":\"PATCH\"}}");
        doAnswer(new org.mockito.stubbing.Answer<Void>() {
            private int call;

            @Override
            public Void answer(org.mockito.invocation.InvocationOnMock invocation) {
                StreamCallback callback = invocation.getArgument(2);
                if (call++ == 0) {
                    callback.onChunk(toolChunk(ChatRequest.ToolCall.builder()
                            .id("call-1")
                            .function(ChatRequest.FunctionCall.builder().name("read_file").arguments("{").build())
                            .build()));
                    callback.onChunk(toolChunk(ChatRequest.ToolCall.builder()
                            .function(ChatRequest.FunctionCall.builder().arguments("\"path\":\"a\"}").build())
                            .build()));
                    callback.onComplete(ChatUsage.builder().promptTokens(3).completionTokens(2).totalTokens(5).build());
                } else {
                    callback.onChunk(contentChunk(null, "done"));
                    callback.onComplete(ChatUsage.builder().promptTokens(4).completionTokens(1).totalTokens(5).build());
                }
                return null;
            }
        }).when(llmAdapter).stream(any(), any(), any(), any());

        agentLoop.execute(context, listener, persistence);

        ArgumentCaptor<Map<String, String>> resultsCaptor = ArgumentCaptor.forClass(Map.class);
        verify(persistence).onSaveAssistantMessage(eq(""), eq(null), any(), resultsCaptor.capture(), any(ChatUsage.class));
        assertThat(resultsCaptor.getValue()).containsKey("call-1");
        verify(persistence).onSaveToolMessage(eq("call-1"),
                eq("{\"ok\":true,\"_private_diff\":{\"diff_mode\":\"PATCH\"}}"));
        verify(persistence).onSaveAssistantMessage(eq("done"), eq(null), eq(List.of()), any(ChatUsage.class));
        verify(listener, times(2)).onToolCallStart(any(ChatRequest.ToolCall.class));
        verify(listener).onToolCallResult(eq("call-1"), anyString());
        assertThat(context.getMessages()).extracting(ChatRequest.Message::getRole)
                .contains("assistant", "tool", "assistant");
    }

    @Test
    void executeStopsBeforeLlmWhenCancelFlagIsSet() {
        AgentExecutionContext context = context();
        AgentEventListener listener = mock(AgentEventListener.class);
        AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(11L);
        cancelFlag.set(true);

        agentLoop.execute(context, listener, null);

        verify(llmAdapter, never()).stream(any(), any(), any(), any());
        verify(shellSessionManager).closeByConversation(11L);
    }

    private AgentExecutionContext context() {
        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(11L);
        context.setUserId(7L);
        context.setExecutionMode("CLOUD");
        context.setWorkspace("/repo");
        context.setPermissionLevel("READ_ONLY");
        context.setMaxRounds(5);
        context.addUserMessage("hi");
        return context;
    }

    private StreamChunk contentChunk(String reasoning, String content) {
        return StreamChunk.builder()
                .choices(List.of(StreamChunk.DeltaChoice.builder()
                        .delta(StreamChunk.Delta.builder()
                                .reasoningContent(reasoning)
                                .content(content)
                                .build())
                        .build()))
                .build();
    }

    private StreamChunk toolChunk(ChatRequest.ToolCall toolCall) {
        return StreamChunk.builder()
                .choices(List.of(StreamChunk.DeltaChoice.builder()
                        .delta(StreamChunk.Delta.builder().toolCalls(List.of(toolCall)).build())
                        .build()))
                .build();
    }
}
