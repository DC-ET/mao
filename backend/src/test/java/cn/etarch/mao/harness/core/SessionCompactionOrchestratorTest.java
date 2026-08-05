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

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionCompactionOrchestratorTest {

    @Mock private SessionCompactionService sessionCompactionService;
    @Mock private SessionCompactionEventService sessionCompactionEventService;
    @Mock private SessionHistoryLoader sessionHistoryLoader;
    @Mock private ContextManager contextManager;
    @Mock private cn.etarch.mao.session.service.SessionService sessionService;
    @Mock private ActiveContextCalculator activeContextCalculator;
    @InjectMocks private SessionCompactionOrchestrator orchestrator;

    @Test
    void compactPersistsReloadsAndPreservesMessagesListReference() {
        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(7L);
        context.setModelConfig(LlmModelConfig.builder().modelId("gpt-test").build());
        List<ChatRequest.Message> messagesRef = context.getMessages();
        messagesRef.add(ChatRequest.Message.builder().role("user").content("old").build());

        SessionCompaction original = compaction(100L, "old");
        SessionCompaction latest = compaction(120L, "new");
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original, latest);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);
        when(sessionCompactionService.boundaryOf(latest)).thenReturn(120L);

        SessionHistoryLoader.HistorySnapshot before = snapshot(
                List.of(message(101L, "USER", "current")));
        SessionHistoryLoader.HistorySnapshot after = snapshot(
                List.of(message(121L, "USER", "retained")));
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L)).thenReturn(before);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 120L)).thenReturn(after);

        CompactionService.SessionCompactionResult result =
                new CompactionService.SessionCompactionResult(
                        "new", 100L, 120L, "snap", 2, 12, 4, 10, 100, 5);
        when(contextManager.compactSession(
                eq(7L), eq(100L), eq("old"), anyList(), anyList(), any(), any(), any(),
                any(), eq(false), isNull()))
                .thenReturn(result);
        when(sessionCompactionService.persist(
                eq(7L), eq(original), eq(100L), eq(120L), eq("snap"),
                eq("new"), eq(12L), eq(4L), eq("gpt-test")))
                .thenReturn(true);
        SessionCompactionEvent recorded = new SessionCompactionEvent();
        recorded.setId(9L);
        when(sessionCompactionEventService.record(
                eq(7L), eq("request_start"), eq(100L), eq(120L),
                eq(2), eq(10), eq(100), eq(5L), eq("gpt-test")))
                .thenReturn(recorded);
        when(activeContextCalculator.estimateMessages(anyList())).thenReturn(20);
        when(activeContextCalculator.estimateText(any())).thenReturn(5);

        boolean advanced = orchestrator.compact(7L, context, null, new CompactionConfig(), false, null);

        assertThat(advanced).isTrue();
        assertThat(context.getMessages()).isSameAs(messagesRef);
        verify(sessionHistoryLoader).applyHistory(eq(context), eq("new"), eq(after));
        verify(sessionCompactionEventService).record(
                eq(7L), eq("request_start"), eq(100L), eq(120L),
                eq(2), eq(10), eq(100), eq(5L), eq("gpt-test"));
        verify(sessionService).clearContextAnchor(7L);
        verify(sessionService).updateContextTokens(7L, 25);
    }

    @Test
    void compactReturnsFalseWhenResultNullAndDoesNotApply() {
        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(7L);
        SessionCompaction original = compaction(100L, "old");
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L))
                .thenReturn(snapshot(List.of(message(101L, "USER", "current"))));
        when(contextManager.compactSession(
                anyLong(), anyLong(), any(), anyList(), anyList(), any(), any(), any(),
                any(), anyBoolean(), any()))
                .thenReturn(null);

        boolean advanced = orchestrator.compact(
                7L, context, null, new CompactionConfig(), true, 99999);

        assertThat(advanced).isFalse();
        verify(sessionCompactionService, never()).persist(
                anyLong(), any(), anyLong(), anyLong(), any(), any(), anyLong(), anyLong(), any());
        verify(sessionHistoryLoader, never()).applyHistory(any(), any(), any());
    }

    @Test
    void compactReturnsFalseWhenPersistFailsButStillAppliesReload() {
        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(7L);
        context.setModelConfig(LlmModelConfig.builder().modelId("gpt-test").build());

        SessionCompaction original = compaction(100L, "old");
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original, original);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);

        SessionHistoryLoader.HistorySnapshot snap = snapshot(
                List.of(message(101L, "USER", "current")));
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 100L)).thenReturn(snap);

        CompactionService.SessionCompactionResult result =
                new CompactionService.SessionCompactionResult(
                        "candidate", 100L, 120L, "snap", 2, 12, 4, 10, 100, 5);
        when(contextManager.compactSession(
                anyLong(), anyLong(), any(), anyList(), anyList(), any(), any(), any(),
                any(), anyBoolean(), any()))
                .thenReturn(result);
        when(sessionCompactionService.persist(
                anyLong(), any(), anyLong(), anyLong(), any(), any(), anyLong(), anyLong(), any()))
                .thenReturn(false);

        boolean advanced = orchestrator.compact(7L, context, null, new CompactionConfig(), false, null);

        assertThat(advanced).isFalse();
        verify(sessionHistoryLoader).applyHistory(eq(context), eq("old"), eq(snap));
        verify(sessionCompactionEventService, never()).record(
                anyLong(), any(), anyLong(), anyLong(), anyInt(),
                anyInt(), anyInt(), anyLong(), any());
    }

    private SessionCompaction compaction(long boundary, String summary) {
        SessionCompaction record = new SessionCompaction();
        record.setSessionId(7L);
        record.setLastCompactedMsgId(boundary);
        record.setSummaryText(summary);
        return record;
    }

    private SessionHistoryLoader.HistorySnapshot snapshot(List<Message> entities) {
        List<PersistedChatMessage> persisted = new ArrayList<>();
        List<Long> ids = new ArrayList<>();
        for (Message m : entities) {
            ids.add(m.getId());
            persisted.add(new PersistedChatMessage(m.getId(),
                    ChatRequest.Message.builder()
                            .role(m.getRole().toLowerCase())
                            .content(m.getContent())
                            .build()));
        }
        return new SessionHistoryLoader.HistorySnapshot(ids, entities, persisted);
    }

    private Message message(long id, String role, String content) {
        Message m = new Message();
        m.setId(id);
        m.setRole(role);
        m.setContent(content);
        return m;
    }
}
