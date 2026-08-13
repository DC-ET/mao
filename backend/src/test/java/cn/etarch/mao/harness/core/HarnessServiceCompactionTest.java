package cn.etarch.mao.harness.core;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.service.AgentExperienceService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.skill.LocalSkillRegistry;
import cn.etarch.mao.harness.skill.SkillLoader;
import cn.etarch.mao.harness.skill.SkillSyncService;
import cn.etarch.mao.harness.tool.ToolRegistry;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.FileChangeMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class HarnessServiceCompactionTest {

    @Mock private AgentLoop agentLoop;
    @Mock private ToolRegistry toolRegistry;
    @Mock private SkillLoader skillLoader;
    @Mock private SkillSyncService skillSyncService;
    @Mock private LocalSkillRegistry localSkillRegistry;
    @Mock private LocalAgentsMdRegistry localAgentsMdRegistry;
    @Mock private SessionMapper sessionMapper;
    @Mock private AgentMapper agentMapper;
    @Mock private AgentExperienceService experienceService;
    @Mock private LlmModelMapper llmModelMapper;
    @Mock private FileChangeMapper fileChangeMapper;
    @Mock private SessionService sessionService;
    @Spy private ObjectMapper objectMapper = new ObjectMapper();
    @Mock private CompactionConfig compactionConfig;
    @Mock private EnvironmentInfoProvider environmentInfoProvider;
    @Mock private SessionCompactionService sessionCompactionService;
    @Mock private SessionHistoryLoader sessionHistoryLoader;
    @Mock private SessionCompactionOrchestrator sessionCompactionOrchestrator;
    @Mock private PromptEngine promptEngine;
    @Mock private ActiveContextCalculator activeContextCalculator;
    @Mock private cn.etarch.mao.harness.mcp.McpClientManager mcpClientManager;
    @Mock private cn.etarch.mao.harness.mcp.local.McpSyncService mcpSyncService;
    @Mock private cn.etarch.mao.permission.service.PermissionService permissionService;

    @InjectMocks private HarnessService harnessService;

    @BeforeEach
    void setUpBaseContext() {
        Session session = new Session();
        session.setId(7L);
        session.setUserId(8L);
        session.setAgentId(9L);
        session.setModelId(10L);
        session.setExecutionMode("CLOUD");
        when(sessionMapper.selectById(7L)).thenReturn(session);
        when(sessionService.loadContextAnchor(7L)).thenReturn(new SessionService.ContextAnchor(0, 0L));

        Agent agent = new Agent();
        agent.setId(9L);
        agent.setName("agent");
        when(agentMapper.selectById(9L)).thenReturn(agent);
        when(experienceService.listEnabledContents(9L)).thenReturn(List.of());

        LlmModel model = new LlmModel();
        model.setId(10L);
        model.setName("model");
        model.setProvider("openai");
        model.setModelId("gpt-test");
        model.setContextWindowTokens(1000);
        when(llmModelMapper.selectById(10L)).thenReturn(model);

        when(environmentInfoProvider.fromSessionOrDetect(session))
                .thenReturn(EnvironmentInfoProvider.EnvironmentInfo.builder()
                        .isGit(false).platform("linux").shell("bash").osVersion("Linux").build());
        when(toolRegistry.getAllTools()).thenReturn(List.of());
        when(promptEngine.buildRequest(any())).thenReturn(
                ChatRequest.builder().messages(List.of()).stream(true).build());
        when(skillLoader.getAllNames()).thenReturn(List.of());
        when(skillLoader.getAllDocuments()).thenReturn(List.of());
        when(skillSyncService.getUserSkillNames(8L)).thenReturn(List.of());
        when(skillSyncService.getUserSkillDocuments(8L)).thenReturn(List.of());

        when(sessionHistoryLoader.loadHistoryAfterBoundary(any(), any(Long.class))).thenAnswer(inv -> {
            long boundary = inv.getArgument(1);
            return historyAfter(boundary);
        });
        org.mockito.Mockito.doAnswer(inv -> {
            AgentExecutionContext ctx = inv.getArgument(0);
            String summary = inv.getArgument(1);
            SessionHistoryLoader.HistorySnapshot history = inv.getArgument(2);
            ctx.getMessages().clear();
            if (summary != null) {
                ctx.getMessages().add(ChatRequest.Message.builder().role("user").content(summary).build());
            }
            for (PersistedChatMessage m : history.persistedMessages()) {
                ctx.getMessages().add(m.chatMessage());
            }
            ctx.setSessionSummary(summary);
            return null;
        }).when(sessionHistoryLoader).applyHistory(any(), any(), any());
    }

    @Test
    void disabledCompactionStillInjectsSummaryAndNeverLoadsFullHistory() {
        SessionCompaction record = compaction(1L, 7L, 100L, "durable summary");
        when(compactionConfig.isEnabled()).thenReturn(false);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(record);
        when(sessionCompactionService.boundaryOf(record)).thenReturn(100L);

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getMessages()).extracting(ChatRequest.Message::getRole)
                .containsExactly("user", "user");
        assertThat(context.getSessionSummary()).isEqualTo("durable summary");
        verify(sessionService).cleanupIncompleteTailAfterId(7L, 100L);
        verify(sessionHistoryLoader).loadHistoryAfterBoundary(7L, 100L);
        verify(sessionService, never()).getMessages(7L);
        verify(sessionCompactionOrchestrator, never()).compact(
                any(), any(), any(), any(), any(), any(Boolean.class), any());
    }

    @Test
    void buildContextUsesOrchestratorAfterPromptPreparation() {
        SessionCompaction original = compaction(1L, 7L, 100L, "old summary");
        when(compactionConfig.isEnabled()).thenReturn(true);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);
        when(sessionCompactionOrchestrator.compact(
                eq(7L), any(), any(ChatRequest.class), isNull(), any(), eq(false), isNull()))
                .thenReturn(true);

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getSessionSummary()).isEqualTo("old summary");
        verify(sessionCompactionOrchestrator).compact(
                eq(7L), any(), any(ChatRequest.class), isNull(), any(), eq(false), isNull());
        verify(sessionService).cleanupIncompleteTailAfterId(7L, 100L);
        verify(sessionService, never()).getMessages(7L);
    }

    @Test
    void compactionExceptionRebuildsPreparedRequestFromCurrentContext() {
        SessionCompaction original = compaction(1L, 7L, 100L, "old summary");
        when(compactionConfig.isEnabled()).thenReturn(true);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);
        ChatRequest before = ChatRequest.builder().messages(List.of(
                ChatRequest.Message.builder().role("user").content("before").build())).stream(true).build();
        ChatRequest rebuilt = ChatRequest.builder().messages(List.of(
                ChatRequest.Message.builder().role("user").content("rebuilt").build())).stream(true).build();
        when(promptEngine.buildRequest(any())).thenReturn(before, rebuilt);
        when(sessionCompactionOrchestrator.compact(
                eq(7L), any(), eq(before), isNull(), any(), eq(false), isNull()))
                .thenThrow(new RuntimeException("post-persist metric failure"));

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getPreparedRequest()).isSameAs(rebuilt);
        verify(promptEngine, times(2)).buildRequest(any());
    }

    @Test
    void missingOrInvalidCompactionRecordRebuildsFromIdZeroOnce() {
        when(compactionConfig.isEnabled()).thenReturn(false);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        when(sessionHistoryLoader.loadHistoryAfterBoundary(7L, 0L)).thenReturn(
                snapshot(List.of(
                        message(10L, 7L, "USER", "full history"),
                        message(20L, 7L, "ASSISTANT", "full answer"))));

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getSessionSummary()).isNull();
        assertThat(context.getMessages()).extracting(ChatRequest.Message::getContent)
                .containsExactly("full history", "full answer");
        verify(sessionService).cleanupIncompleteTailAfterId(7L, 0L);
        verify(sessionHistoryLoader).loadHistoryAfterBoundary(7L, 0L);
        verify(sessionService, never()).getMessages(7L);
    }

    private SessionHistoryLoader.HistorySnapshot historyAfter(long boundary) {
        if (boundary == 0L) {
            return snapshot(List.of(
                    message(10L, 7L, "USER", "full history"),
                    message(20L, 7L, "ASSISTANT", "full answer")));
        }
        if (boundary == 100L) {
            return snapshot(List.of(message(101L, 7L, "USER", "current")));
        }
        if (boundary == 120L) {
            return snapshot(List.of(
                    message(121L, 7L, "USER", "retained"),
                    message(130L, 7L, "ASSISTANT", "written concurrently")));
        }
        if (boundary == 150L) {
            return snapshot(List.of(message(151L, 7L, "USER", "latest current")));
        }
        return snapshot(List.of(message(boundary + 1, 7L, "USER", "current")));
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

    private SessionCompaction compaction(long id, long sessionId, long boundary, String summary) {
        SessionCompaction record = new SessionCompaction();
        record.setId(id);
        record.setSessionId(sessionId);
        record.setLastCompactedMsgId(boundary);
        record.setSummaryText(summary);
        return record;
    }

    private Message message(long id, long sessionId, String role, String content) {
        Message message = new Message();
        message.setId(id);
        message.setSessionId(sessionId);
        message.setRole(role);
        message.setContent(content);
        return message;
    }
}
