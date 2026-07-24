package cn.etarch.mao.session.ws;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.auth.service.JwtService;
import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.core.LocalAgentsMdRegistry;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.harness.shell.ShellSessionManager;
import cn.etarch.mao.harness.skill.LocalSkillRegistry;
import cn.etarch.mao.harness.skill.SkillSyncService;
import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import cn.etarch.mao.harness.tool.AskUserQuestionsRegistry;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.activity.SessionActivityHeartbeat;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.MessageQueue;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.MessageQueueService;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.TaskTerminalService;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.net.URI;
import java.time.LocalDateTime;
import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import org.mockito.ArgumentMatchers;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class StreamingWsHandlerTest {

    private final StreamingWsRegistry registry = mock(StreamingWsRegistry.class);
    private final HarnessService harnessService = mock(HarnessService.class);
    private final SessionService sessionService = mock(SessionService.class);
    private final TaskTerminalService taskTerminalService = mock(TaskTerminalService.class);
    private final MessageQueueService messageQueueService = mock(MessageQueueService.class);
    private final LocalToolSessionRegistry localToolSessionRegistry = mock(LocalToolSessionRegistry.class);
    private final AskUserQuestionsRegistry askUserQuestionsRegistry = mock(AskUserQuestionsRegistry.class);
    private final ActivityService activityService = mock(ActivityService.class);
    private final SessionActivityHeartbeat activityHeartbeat = mock(SessionActivityHeartbeat.class);
    private final SessionTodoMapper sessionTodoMapper = mock(SessionTodoMapper.class);
    private final AgentLoop agentLoop = mock(AgentLoop.class);
    private final ShellSessionManager shellSessionManager = mock(ShellSessionManager.class);
    private final SkillSyncService skillSyncService = mock(SkillSyncService.class);
    private final LocalSkillRegistry localSkillRegistry = mock(LocalSkillRegistry.class);
    private final LocalAgentsMdRegistry localAgentsMdRegistry = mock(LocalAgentsMdRegistry.class);
    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final LlmModelMapper llmModelMapper = mock(LlmModelMapper.class);
    private final JwtService jwtService = mock(JwtService.class);
    private final CapturingExecutor executor = new CapturingExecutor();
    private final StreamingWsHandler handler = new StreamingWsHandler(
            registry, harnessService, sessionService, taskTerminalService, messageQueueService, localToolSessionRegistry,
            askUserQuestionsRegistry, activityService, activityHeartbeat, sessionTodoMapper, agentLoop,
            shellSessionManager, skillSyncService, localSkillRegistry, localAgentsMdRegistry,
            agentMapper, llmModelMapper, jwtService, executor);
    private final WebSocketSession ws = mock(WebSocketSession.class);

    @Test
    void sendMessagePersistsUserMessageAndRunsCloudExecution() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        when(sessionService.getSession(11L)).thenReturn(session("CLOUD", "IDLE"));
        when(sessionService.saveMessage(eq(11L), eq("USER"), any(Object.class), eq(null), eq(null), eq(null), eq(0), eq(null)))
                .thenReturn(message(99L, "USER"));
        when(harnessService.prepareMessage(eq(11L), any())).thenReturn("event-1");
        when(agentLoop.registerCancelFlag(11L)).thenReturn(new AtomicBoolean(false));
        Agent agent = new Agent();
        agent.setId(5L);
        when(agentMapper.selectById(5L)).thenReturn(agent);
        when(messageQueueService.listPending(11L)).thenReturn(List.of());

        handler.handleTextMessage(ws, json("""
                {"type":"send_message","sessionId":11,"data":{"content":"hello","eventId":"event-1"}}
                """));
        executor.runAll();

        verify(sessionService).saveMessage(eq(11L), eq("USER"), eq((Object) "hello"),
                eq(null), eq(null), eq(null), eq(0), eq(null));
        verify(registry).subscribe(7L, 11L);
        verify(skillSyncService).syncToSession(agent, 7L, 11L);
        verify(harnessService).executeFromEvent(eq(11L), eq("event-1"), any(), any(AtomicBoolean.class));
        verify(sessionService).updatePhase(11L, "RUNNING");
        verify(taskTerminalService).finishExecution(11L, 7L, "COMPLETED", "event-1");
        verify(activityHeartbeat).clear(11L);
        verify(agentLoop).removeCancelFlag(11L);
    }

    @Test
    void sendMessageRejectsUnsupportedImagesAndDisconnectedLocalClient() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        Session cloud = session("CLOUD", "IDLE");
        cloud.setModelId(2L);
        when(sessionService.getSession(11L)).thenReturn(cloud);
        LlmModel model = new LlmModel();
        model.setSupportsVision(0);
        when(llmModelMapper.selectById(2L)).thenReturn(model);

        handler.handleTextMessage(ws, json("""
                {"type":"send_message","sessionId":11,"data":{"content":"hello","images":["img"]}}
                """));

        verify(registry).send(eq(7L), any(WsEvent.class));
        verify(harnessService, never()).executeFromEvent(any(), any(), any(), any());

        Session local = session("LOCAL", "IDLE");
        when(sessionService.getSession(12L)).thenReturn(local);
        when(localToolSessionRegistry.isConnected(12L)).thenReturn(false);

        handler.handleTextMessage(ws, json("""
                {"type":"send_message","sessionId":12,"data":{"content":"hello"}}
                """));

        verify(localToolSessionRegistry).setUserForSession(12L, 7L);
    }

    @Test
    void editAndResendValidatesLastUserMessageAndRunsExecution() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        when(sessionService.getSession(11L)).thenReturn(session("CLOUD", "IDLE"));
        when(sessionService.getMessages(11L)).thenReturn(List.of(message(1L, "USER"), message(2L, "ASSISTANT"), message(3L, "USER")));
        when(sessionService.editMessageAndTruncate(3L, "edited", List.of())).thenReturn(message(3L, "USER"));
        when(harnessService.prepareMessage(eq(11L), any())).thenReturn("edit-event");
        when(agentLoop.registerCancelFlag(11L)).thenReturn(new AtomicBoolean(false));
        when(messageQueueService.listPending(11L)).thenReturn(List.of());

        handler.handleTextMessage(ws, json("""
                {"type":"edit_and_resend","sessionId":11,"messageId":3,"content":"edited"}
                """));
        executor.runAll();

        verify(sessionService).editMessageAndTruncate(3L, "edited", List.of());
        verify(harnessService).executeFromEvent(eq(11L), eq("edit-event"), any(), any(AtomicBoolean.class));
        verify(taskTerminalService).finishExecution(11L, 7L, "COMPLETED", "edit-event");
    }

    @Test
    void queueAndToolMessagesAreRoutedToCollaborators() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        MessageQueue queue = new MessageQueue();
        queue.setId(4L);
        queue.setSessionId(11L);
        queue.setContent("queued");
        queue.setSortOrder(1);
        queue.setImages("[\"img\"]");
        queue.setCreatedAt(LocalDateTime.parse("2026-07-07T10:00:00"));
        when(messageQueueService.listPending(11L)).thenReturn(List.of(queue));

        handler.handleTextMessage(ws, json("""
                {"type":"subscribe","sessionId":11}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"unsubscribe","sessionId":11}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"enqueue_message","sessionId":11,"data":{"content":"queued","images":["img"]}}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"delete_queue_message","sessionId":11,"data":{"queueId":4}}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"reorder_queue_message","sessionId":11,"data":{"queueId":4,"direction":"up"}}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"tool_result","sessionId":11,"requestId":"req","result":"ok"}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"tool_error","sessionId":11,"requestId":"req","error":"bad"}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"ask_user_questions_result","sessionId":11,"data":{"requestId":"q","answers":[{"id":"a"}]}}
                """));
        handler.handleTextMessage(ws, json("""
                {"type":"ping"}
                """));

        verify(registry).subscribe(7L, 11L);
        verify(registry).unsubscribe(7L, 11L);
        verify(messageQueueService).enqueue(11L, 7L, "queued", "[\"img\"]");
        verify(messageQueueService).delete(4L);
        verify(messageQueueService).reorder(4L, "up");
        verify(localToolSessionRegistry).completeToolRequest(11L, "req", "ok");
        verify(localToolSessionRegistry).completeToolRequestError(11L, "req", "bad");
        verify(askUserQuestionsRegistry).complete(eq(11L), eq("q"), eq("{\"answers\": [{\"id\":\"a\"}]}"));
    }

    @Test
    void createSideSessionSavesChildAndExecutesFirstMessage() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        Session parent = session("CLOUD", "IDLE");
        parent.setWorkspace("/repo");
        when(sessionService.getSession(11L)).thenReturn(parent);
        when(sessionService.generateTitleFromUserMessage(7L, "side work")).thenReturn("Side work");
        when(sessionService.saveMessage(eq(13L), eq("USER"), eq("side work"), eq(null), eq(null), eq(null), eq(0), eq(null)))
                .thenReturn(message(99L, "USER"));
        when(agentLoop.registerCancelFlag(any())).thenReturn(new AtomicBoolean(false));
        doAnswer(invocation -> {
            Session sideSession = invocation.getArgument(0);
            sideSession.setId(13L);
            return null;
        }).when(sessionService).save(any(Session.class));

        handler.handleTextMessage(ws, json("""
                {"type":"create_side_session","sessionId":11,"data":{"content":"side work","inheritContext":true,"modelId":9}}
                """));
        executor.runAll();

        verify(sessionService).save(any(Session.class));
        verify(sessionService).saveMessage(eq(13L), eq("USER"), eq("side work"), eq(null), eq(null), eq(null), eq(0), eq(null));
        verify(harnessService).executeSideFirstMessage(eq(11L), eq(13L), eq(true), any(), any(AtomicBoolean.class));
    }

    @Test
    void createSideSessionPersistsMultimodalImagesOnFirstMessage() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        Session parent = session("CLOUD", "IDLE");
        parent.setWorkspace("/repo");
        when(sessionService.getSession(11L)).thenReturn(parent);
        when(sessionService.generateTitleFromUserMessage(7L, "look")).thenReturn("Look");
        when(sessionService.saveMessage(eq(13L), eq("USER"), any(Object.class), eq(null), eq(null), eq(null), eq(0), eq(null)))
                .thenReturn(message(99L, "USER"));
        when(agentLoop.registerCancelFlag(any())).thenReturn(new AtomicBoolean(false));
        LlmModel visionModel = new LlmModel();
        visionModel.setSupportsVision(1);
        when(llmModelMapper.selectById(9L)).thenReturn(visionModel);
        doAnswer(invocation -> {
            Session sideSession = invocation.getArgument(0);
            sideSession.setId(13L);
            return null;
        }).when(sessionService).save(any(Session.class));

        handler.handleTextMessage(ws, json("""
                {"type":"create_side_session","sessionId":11,"data":{"content":"look","inheritContext":false,"modelId":9,"images":["https://cdn.example/a.png"]}}
                """));
        executor.runAll();

        verify(sessionService).saveMessage(eq(13L), eq("USER"),
                ArgumentMatchers.<Object>argThat(content -> content instanceof List && ((List<?>) content).size() == 2),
                eq(null), eq(null), eq(null), eq(0), eq(null));
        verify(harnessService).executeSideFirstMessage(eq(11L), eq(13L), eq(false), any(), any(AtomicBoolean.class));
    }

    @Test
    void createSideSessionRejectsImagesWhenModelLacksVision() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        Session parent = session("CLOUD", "IDLE");
        parent.setModelId(2L);
        when(sessionService.getSession(11L)).thenReturn(parent);
        LlmModel model = new LlmModel();
        model.setSupportsVision(0);
        when(llmModelMapper.selectById(2L)).thenReturn(model);

        handler.handleTextMessage(ws, json("""
                {"type":"create_side_session","sessionId":11,"data":{"content":"look","inheritContext":true,"images":["https://cdn.example/a.png"]}}
                """));

        verify(sessionService, never()).save(any(Session.class));
        verify(registry).send(eq(7L), any(WsEvent.class));
        verify(harnessService, never()).executeSideFirstMessage(any(), any(), anyBoolean(), any(), any());
    }

    @Test
    void createSideSessionInLocalModeRegistersToolSessionAndReportsLocalSkills() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        when(registry.hasLocalClientConnection(7L)).thenReturn(true);
        Session parent = session("LOCAL", "IDLE");
        parent.setWorkspace("/repo");
        when(sessionService.getSession(11L)).thenReturn(parent);
        when(sessionService.generateTitleFromUserMessage(7L, "side work")).thenReturn("Side work");
        when(sessionService.saveMessage(eq(13L), eq("USER"), eq("side work"), eq(null), eq(null), eq(null), eq(0), eq(null)))
                .thenReturn(message(99L, "USER"));
        when(agentLoop.registerCancelFlag(any())).thenReturn(new AtomicBoolean(false));
        doAnswer(invocation -> {
            Session sideSession = invocation.getArgument(0);
            sideSession.setId(13L);
            return null;
        }).when(sessionService).save(any(Session.class));

        handler.handleTextMessage(ws, json("""
                {"type":"create_side_session","sessionId":11,"data":{"content":"side work","inheritContext":true,"modelId":9,
                "localSkills":[{"name":"my-skill","description":"desc","folderName":"my-skill"}]}}
                """));
        executor.runAll();

        verify(localToolSessionRegistry).setUserForSession(13L, 7L);
        verify(localSkillRegistry).report(eq(13L), argThat(list ->
                list.size() == 1 && "my-skill".equals(list.get(0).getName())));
        verify(harnessService).executeSideFirstMessage(eq(11L), eq(13L), eq(true), any(), any(AtomicBoolean.class));
    }

    @Test
    void createSideSessionInLocalModeFailsWhenDesktopNotConnected() throws Exception {
        when(registry.getUserId(ws)).thenReturn(7L);
        when(registry.hasLocalClientConnection(7L)).thenReturn(false);
        Session parent = session("LOCAL", "IDLE");
        parent.setWorkspace("/repo");
        when(sessionService.getSession(11L)).thenReturn(parent);

        handler.handleTextMessage(ws, json("""
                {"type":"create_side_session","sessionId":11,"data":{"content":"side work","inheritContext":true}}
                """));
        executor.runAll();

        verify(sessionService, never()).save(any(Session.class));
        verify(registry).send(eq(7L), any(WsEvent.class));
    }

    @Test
    void connectionLifecycleUsesTokenAndCleanupHooks() throws Exception {
        String token = "valid.jwt.token";
        when(jwtService.validateToken(token)).thenReturn(true);
        when(jwtService.getUserIdFromToken(token)).thenReturn(7L);
        WebSocketSession connected = mock(WebSocketSession.class);
        when(connected.getUri()).thenReturn(URI.create("ws://localhost/ws?token=" + token + "&client=electron"));
        when(connected.getId()).thenReturn("ws-1");
        when(registry.getUserId(connected)).thenReturn(7L);
        when(registry.getSubscribedSessionIds(7L)).thenReturn(java.util.Set.of(11L));
        when(registry.hasLocalClientConnection(7L)).thenReturn(false);

        handler.afterConnectionEstablished(connected);
        handler.afterConnectionClosed(connected, org.springframework.web.socket.CloseStatus.NORMAL);
        handler.handleTransportError(connected, new IllegalStateException("boom"));

        verify(registry).register(connected, 7L, "electron");
        verify(localToolSessionRegistry, times(2)).failAllForUser(7L);
        verify(askUserQuestionsRegistry, times(2)).failAllForSessions(java.util.Set.of(11L));
    }

    @Test
    void connectionRejectsForgedOrInvalidJwt() throws Exception {
        String forged = "header." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"sub\":\"7\"}".getBytes()) + ".sig";
        when(jwtService.validateToken(forged)).thenReturn(false);
        WebSocketSession connected = mock(WebSocketSession.class);
        when(connected.getUri()).thenReturn(URI.create("ws://localhost/ws?token=" + forged + "&client=browser"));

        handler.afterConnectionEstablished(connected);

        verify(connected).close(argThat(status ->
                status.getCode() == org.springframework.web.socket.CloseStatus.NOT_ACCEPTABLE.getCode()));
        verify(registry, never()).register(any(), any(), any());
        verify(jwtService, never()).getUserIdFromToken(any());
    }

    private TextMessage json(String payload) {
        return new TextMessage(payload);
    }

    private Session session(String mode, String phase) {
        Session session = new Session();
        session.setId(11L);
        session.setUserId(7L);
        session.setAgentId(5L);
        session.setExecutionMode(mode);
        session.setPhase(phase);
        session.setPermissionLevel("READ_ONLY");
        session.setStatus("ACTIVE");
        return session;
    }

    private Message message(Long id, String role) {
        Message message = new Message();
        message.setId(id);
        message.setSessionId(11L);
        message.setRole(role);
        message.setContent("content");
        message.setCreatedAt(LocalDateTime.now());
        return message;
    }

    private static final class CapturingExecutor extends AbstractExecutorService {
        private final ArrayDeque<FutureTask<?>> tasks = new ArrayDeque<>();
        private boolean shutdown;

        @Override
        public void shutdown() {
            shutdown = true;
        }

        @Override
        public List<Runnable> shutdownNow() {
            shutdown = true;
            return List.of();
        }

        @Override
        public boolean isShutdown() {
            return shutdown;
        }

        @Override
        public boolean isTerminated() {
            return shutdown && tasks.isEmpty();
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return isTerminated();
        }

        @Override
        public void execute(Runnable command) {
            tasks.add(new FutureTask<>(command, null));
        }

        void runAll() {
            while (!tasks.isEmpty()) {
                tasks.removeFirst().run();
            }
        }
    }
}
