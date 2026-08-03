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
import static org.mockito.Mockito.never;
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
    @Mock private ContextManager contextManager;
    @Mock private CompactionConfig compactionConfig;
    @Mock private EnvironmentInfoProvider environmentInfoProvider;
    @Mock private SessionCompactionService sessionCompactionService;
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
        when(skillLoader.getAllNames()).thenReturn(List.of());
        when(skillLoader.getAllDocuments()).thenReturn(List.of());
        when(skillSyncService.getUserSkillNames(8L)).thenReturn(List.of());
        when(skillSyncService.getUserSkillDocuments(8L)).thenReturn(List.of());
        when(contextManager.prependSessionSummary(any(), anyList())).thenAnswer(invocation -> {
            String summary = invocation.getArgument(0);
            List<ChatRequest.Message> increment = invocation.getArgument(1);
            List<ChatRequest.Message> result = new ArrayList<>();
            if (summary != null) {
                result.add(ChatRequest.Message.builder().role("system").content(summary).build());
            }
            result.addAll(increment);
            return result;
        });
    }

    @Test
    void disabledCompactionStillInjectsSummaryAndNeverLoadsFullHistory() {
        SessionCompaction record = compaction(1L, 7L, 100L, "durable summary");
        when(compactionConfig.isEnabled()).thenReturn(false);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(record);
        when(sessionCompactionService.boundaryOf(record)).thenReturn(100L);
        when(sessionService.getMessagesAfterId(7L, 100L))
                .thenReturn(List.of(message(101L, 7L, "USER", "current")));

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getMessages()).extracting(ChatRequest.Message::getRole)
                .containsExactly("system", "user");
        assertThat(context.getSessionSummary()).isEqualTo("durable summary");
        verify(sessionService).cleanupIncompleteTailAfterId(7L, 100L);
        verify(sessionService).getMessagesAfterId(7L, 100L);
        verify(sessionService, never()).getMessages(7L);
        verify(contextManager, never()).compactSession(
                any(), any(Long.class), any(), anyList(), anyList(), any(), any(), any());
    }

    @Test
    void casConflictDiscardsCandidateAndReloadsLatestSummaryOnce() {
        SessionCompaction original = compaction(1L, 7L, 100L, "old summary");
        SessionCompaction latest = compaction(1L, 7L, 150L, "winner summary");
        when(compactionConfig.isEnabled()).thenReturn(true);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original, latest);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);
        when(sessionCompactionService.boundaryOf(latest)).thenReturn(150L);
        when(sessionService.getMessagesAfterId(7L, 100L))
                .thenReturn(List.of(message(101L, 7L, "USER", "current")));
        when(sessionService.getMessagesAfterId(7L, 150L))
                .thenReturn(List.of(message(151L, 7L, "USER", "latest current")));

        CompactionService.SessionCompactionResult candidate =
                new CompactionService.SessionCompactionResult(
                        "loser summary", 100L, 120L, "boundary snapshot",
                        2, 12, 4, 10, 100, 5);
        when(contextManager.compactSession(
                eq(7L), eq(100L), eq("old summary"), anyList(), anyList(), any(), any(), any()))
                .thenReturn(candidate);
        when(sessionCompactionService.persist(
                7L, original, 100L, 120L, "boundary snapshot",
                "loser summary", 12L, 4L, "gpt-test"))
                .thenReturn(false);

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getSessionSummary()).isEqualTo("winner summary");
        assertThat(context.getMessages()).extracting(ChatRequest.Message::getContent)
                .containsExactly("winner summary", "latest current");
        verify(contextManager).compactSession(
                eq(7L), eq(100L), eq("old summary"), anyList(), anyList(), any(), any(), any());
        verify(sessionService).getMessagesAfterId(7L, 150L);
        verify(sessionService, never()).getMessages(7L);
    }

    @Test
    void successfulCompactionReloadsMessagesWrittenDuringGeneration() {
        SessionCompaction original = compaction(1L, 7L, 100L, "old summary");
        SessionCompaction persisted = compaction(1L, 7L, 120L, "new summary");
        when(compactionConfig.isEnabled()).thenReturn(true);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(original, persisted);
        when(sessionCompactionService.boundaryOf(original)).thenReturn(100L);
        when(sessionCompactionService.boundaryOf(persisted)).thenReturn(120L);
        when(sessionService.getMessagesAfterId(7L, 100L))
                .thenReturn(List.of(message(101L, 7L, "USER", "snapshot current")));
        when(sessionService.getMessagesAfterId(7L, 120L))
                .thenReturn(List.of(
                        message(121L, 7L, "USER", "retained"),
                        message(130L, 7L, "ASSISTANT", "written concurrently")));

        CompactionService.SessionCompactionResult candidate =
                new CompactionService.SessionCompactionResult(
                        "new summary", 100L, 120L, "boundary snapshot",
                        2, 12, 4, 10, 100, 5);
        when(contextManager.compactSession(
                eq(7L), eq(100L), eq("old summary"), anyList(), anyList(), any(), any(), any()))
                .thenReturn(candidate);
        when(sessionCompactionService.persist(
                7L, original, 100L, 120L, "boundary snapshot",
                "new summary", 12L, 4L, "gpt-test"))
                .thenReturn(true);

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getSessionSummary()).isEqualTo("new summary");
        assertThat(context.getMessages()).extracting(ChatRequest.Message::getContent)
                .containsExactly("new summary", "retained", "written concurrently");
        verify(sessionService).getMessagesAfterId(7L, 120L);
        verify(sessionService, never()).getMessages(7L);
    }

    @Test
    void missingOrInvalidCompactionRecordRebuildsFromIdZeroOnce() {
        when(compactionConfig.isEnabled()).thenReturn(false);
        when(sessionCompactionService.loadValidated(7L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        when(sessionService.getMessagesAfterId(7L, 0L))
                .thenReturn(List.of(
                        message(10L, 7L, "USER", "full history"),
                        message(20L, 7L, "ASSISTANT", "full answer")));

        AgentExecutionContext context = harnessService.buildContext(7L);

        assertThat(context.getSessionSummary()).isNull();
        assertThat(context.getMessages()).extracting(ChatRequest.Message::getContent)
                .containsExactly("full history", "full answer");
        verify(sessionService).cleanupIncompleteTailAfterId(7L, 0L);
        verify(sessionService).getMessagesAfterId(7L, 0L);
        verify(sessionService, never()).getMessages(7L);
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
