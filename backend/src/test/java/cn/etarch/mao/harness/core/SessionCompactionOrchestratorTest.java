package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.entity.SessionCompactionEvent;
import cn.etarch.mao.session.service.SessionCompactionEventService;
import cn.etarch.mao.session.service.SessionCompactionService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SessionCompactionOrchestratorTest {
    @Mock SessionCompactionService sessionCompactionService;
    @Mock SessionCompactionEventService sessionCompactionEventService;
    @Mock SessionHistoryLoader sessionHistoryLoader;
    @Mock ContextManager contextManager;
    @Mock cn.etarch.mao.session.service.SessionService sessionService;
    @Mock ActiveContextCalculator activeContextCalculator;
    @Mock PromptEngine promptEngine;
    @InjectMocks SessionCompactionOrchestrator orchestrator;

    @Test
    void successPersistsUsageReloadsAndResetsAnchor() {
        AgentExecutionContext context = context();
        ChatRequest beforeRequest = request("before");
        ChatRequest afterRequest = request("after");
        SessionCompaction old = compaction(100, "old");
        SessionCompaction latest = compaction(120, "new");
        SessionHistoryLoader.HistorySnapshot before = snapshot(101, "current");
        SessionHistoryLoader.HistorySnapshot after = snapshot(121, "after");
        when(sessionCompactionService.loadValidated(7L)).thenReturn(old, latest);
        when(sessionCompactionService.boundaryOf(old)).thenReturn(100L);
        when(sessionCompactionService.boundaryOf(latest)).thenReturn(120L);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L)).thenReturn(before);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 120L)).thenReturn(after);
        when(contextManager.compactSession(eq(7L), eq(100L), anyList(), anyList(), eq(beforeRequest),
                any(), any(), any(), any())).thenReturn(result());
        when(sessionCompactionService.persist(eq(7L), eq(old), eq(100L), eq(120L), eq("snap"),
                eq("new"), eq(12L), eq(4L), eq("gpt-test"))).thenReturn(true);
        when(promptEngine.buildRequest(context)).thenReturn(afterRequest);
        when(activeContextCalculator.estimateRequestTokens(afterRequest)).thenReturn(40);
        SessionCompactionEvent event = new SessionCompactionEvent(); event.setId(9L);
        when(sessionCompactionEventService.record(7L, "request_start", 100L, 120L, 1,
                12, 8, 4, 10, 60, 5L, "gpt-test")).thenReturn(event);

        assertThat(orchestrator.compact(7L, context, beforeRequest, null,
                new CompactionConfig(), false, null)).isTrue();
        verify(sessionHistoryLoader).applyHistory(context, "new", after);
        verify(sessionCompactionEventService).record(7L, "request_start", 100L, 120L, 1,
                12, 8, 4, 10, 60, 5L, "gpt-test");
        verify(sessionService).clearContextAnchor(7L);
        verify(sessionService).updateContextTokens(7L, 40);
        assertThat(context.getLastPromptTokens()).isZero();
        assertThat(context.getContextAnchorMsgId()).isZero();
    }

    @Test
    void recoverableFailureDoesNotPersist() {
        AgentExecutionContext context = context();
        SessionCompaction old = compaction(100, "old");
        when(sessionCompactionService.loadValidated(7L)).thenReturn(old);
        when(sessionCompactionService.boundaryOf(old)).thenReturn(100L);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L)).thenReturn(snapshot(101, "x"));
        when(contextManager.compactSession(anyLong(), anyLong(), anyList(), anyList(), any(), any(), any(), any(), any()))
                .thenReturn(null);
        assertThat(orchestrator.compact(7L, context, request("before"), null,
                new CompactionConfig(), true, null)).isFalse();
        verify(sessionCompactionService, never()).persist(anyLong(), any(), anyLong(), anyLong(), any(), any(), anyLong(), anyLong(), any());
    }

    @Test
    void casFailureReloadsConcurrentResultWithoutEvent() {
        AgentExecutionContext context = context();
        SessionCompaction old = compaction(100, "old");
        SessionCompaction concurrent = compaction(115, "other");
        when(sessionCompactionService.loadValidated(7L)).thenReturn(old, concurrent);
        when(sessionCompactionService.boundaryOf(old)).thenReturn(100L);
        when(sessionCompactionService.boundaryOf(concurrent)).thenReturn(115L);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L)).thenReturn(snapshot(101, "x"));
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 115L)).thenReturn(snapshot(116, "y"));
        when(contextManager.compactSession(anyLong(), anyLong(), anyList(), anyList(), any(), any(), any(), any(), any()))
                .thenReturn(result());
        when(sessionCompactionService.persist(anyLong(), any(), anyLong(), anyLong(), any(), any(), anyLong(), anyLong(), any()))
                .thenReturn(false);
        ChatRequest concurrentRequest = request("concurrent");
        when(promptEngine.buildRequest(context)).thenReturn(concurrentRequest);
        when(activeContextCalculator.estimateRequestTokens(concurrentRequest)).thenReturn(30);
        assertThat(orchestrator.compact(7L, context, request("before"), null,
                new CompactionConfig(), false, null)).isFalse();
        verify(sessionHistoryLoader).applyHistory(eq(context), eq("other"), any());
        verify(sessionService).clearContextAnchor(7L);
        verify(sessionService).updateContextTokens(7L, 30);
        assertThat(context.getLastPromptTokens()).isZero();
        assertThat(context.getContextAnchorMsgId()).isZero();
        assertThat(context.getMessagesCoveredByAnchor()).isEqualTo(-1);
        verifyNoInteractions(sessionCompactionEventService);
    }

    @Test
    void persistSuccessThenReloadFailureStopsInsteadOfUsingOldContext() {
        AgentExecutionContext context = context();
        SessionCompaction old = compaction(100, "old");
        when(sessionCompactionService.loadValidated(7L))
                .thenReturn(old)
                .thenThrow(new RuntimeException("db unavailable"));
        when(sessionCompactionService.boundaryOf(old)).thenReturn(100L);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L)).thenReturn(snapshot(101, "x"));
        when(contextManager.compactSession(anyLong(), anyLong(), anyList(), anyList(), any(), any(), any(), any(), any()))
                .thenReturn(result());
        when(sessionCompactionService.persist(anyLong(), any(), anyLong(), anyLong(), any(), any(), anyLong(), anyLong(), any()))
                .thenReturn(true);

        assertThatThrownBy(() -> orchestrator.compact(7L, context, request("before"), null,
                new CompactionConfig(), false, null))
                .isInstanceOf(SessionCompactionOrchestrator.CompactionStateReloadException.class);
        assertThat(context.getMessages()).isEmpty();
        verifyNoInteractions(sessionCompactionEventService);
    }

    private AgentExecutionContext context() {
        AgentExecutionContext c = new AgentExecutionContext();
        c.setSessionId(7L); c.setModelConfig(LlmModelConfig.builder().modelId("gpt-test").build());
        c.setLastPromptTokens(50); c.setContextAnchorMsgId(100);
        return c;
    }
    private CompactionService.SessionCompactionResult result() {
        return new CompactionService.SessionCompactionResult("new", 100L, 120L, "snap",
                1, 12, 8, 4, 10, 0, 100, 5);
    }
    private SessionCompaction compaction(long boundary, String summary) {
        SessionCompaction c = new SessionCompaction(); c.setSessionId(7L);
        c.setLastCompactedMsgId(boundary); c.setSummaryText(summary); return c;
    }
    private ChatRequest request(String content) {
        return ChatRequest.builder().messages(List.of(ChatRequest.Message.builder().role("user").content(content).build())).build();
    }
    private SessionHistoryLoader.HistorySnapshot snapshot(long id, String content) {
        Message m = new Message(); m.setId(id); m.setRole("USER"); m.setContent(content);
        PersistedChatMessage pm = new PersistedChatMessage(id, content,
                ChatRequest.Message.builder().role("user").content(content).build());
        return new SessionHistoryLoader.HistorySnapshot(List.of(id), List.of(m), List.of(pm));
    }
}
