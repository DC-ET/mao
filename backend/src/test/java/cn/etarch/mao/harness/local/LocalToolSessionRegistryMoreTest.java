package cn.etarch.mao.harness.local;

import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LocalToolSessionRegistryMoreTest {

    private final StreamingWsRegistry wsRegistry = mock(StreamingWsRegistry.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final LocalToolSessionRegistry registry = new LocalToolSessionRegistry(wsRegistry, sessionMapper);

    @Test
    void resolvesUserFromMemorySessionRecordAndParentSession() {
        registry.setUserForSession(1L, 7L);
        when(wsRegistry.hasLocalClientConnection(7L)).thenReturn(true);
        assertThat(registry.getUserIdForSession(1L)).isEqualTo(7L);
        assertThat(registry.isConnected(1L)).isTrue();

        Session session = new Session();
        session.setId(2L);
        session.setUserId(8L);
        when(sessionMapper.selectById(2L)).thenReturn(session);
        when(wsRegistry.hasLocalClientConnection(8L)).thenReturn(false);
        assertThat(registry.getUserIdForSession(2L)).isEqualTo(8L);
        assertThat(registry.isConnected(2L)).isFalse();

        Session sub = new Session();
        sub.setId(3L);
        sub.setSessionType("SUBAGENT");
        sub.setParentSessionId(1L);
        when(sessionMapper.selectById(3L)).thenReturn(sub);
        assertThat(registry.getUserIdForSession(3L)).isEqualTo(7L);
        assertThat(registry.getUserIdForSession(null)).isNull();
    }

    @Test
    void sendsCompletesAndFailsPendingToolRequests() throws Exception {
        registry.setUserForSession(10L, 7L);
        when(wsRegistry.hasLocalClientConnection(7L)).thenReturn(true);

        var pending = registry.sendToolRequest(10L, "read_file", "{\"path\":\"a\"}", "/repo", true, "danger");
        CompletableFuture<String> future = pending.future();

        ArgumentCaptor<WsEvent> eventCaptor = ArgumentCaptor.forClass(WsEvent.class);
        verify(wsRegistry).sendToLocalClients(org.mockito.Mockito.eq(7L), eventCaptor.capture());
        String requestId = eventCaptor.getValue().getData().get("requestId").toString();
        assertThat(pending.requestId()).isEqualTo(requestId);
        assertThat(eventCaptor.getValue().getData().get("dangerReason")).isEqualTo("danger");

        registry.completeToolRequest(10L, requestId, "{\"ok\":true}");
        assertThat(future.get()).isEqualTo("{\"ok\":true}");

        var errorPending = registry.sendToolRequest(10L, "shell", null, null, false, null);
        CompletableFuture<String> errorFuture = errorPending.future();
        verify(wsRegistry, times(2)).sendToLocalClients(org.mockito.Mockito.eq(7L), eventCaptor.capture());
        String errorRequestId = eventCaptor.getAllValues()
                .get(eventCaptor.getAllValues().size() - 1)
                .getData().get("requestId").toString();
        registry.completeToolRequestError(10L, errorRequestId, "bad \"thing\"");
        assertThat(errorFuture.get()).contains("bad 'thing'");
    }

    @Test
    void timeoutFailsOnlyMatchingRequestLeavingSiblingPending() throws Exception {
        registry.setUserForSession(10L, 7L);
        when(wsRegistry.hasLocalClientConnection(7L)).thenReturn(true);

        var first = registry.sendToolRequest(10L, "read_file", "{}", "/repo", false, null);
        var second = registry.sendToolRequest(10L, "shell", "{}", "/repo", false, null);

        registry.completeToolRequestError(10L, first.requestId(), "Local tool execution timed out after 1 seconds");

        assertThat(first.future().get()).contains("timed out");
        assertThat(second.future().isDone()).isFalse();

        registry.completeToolRequest(10L, second.requestId(), "{\"ok\":true}");
        assertThat(second.future().get()).isEqualTo("{\"ok\":true}");
    }

    @Test
    void unregisteredOrDisconnectedSessionsReturnErrorAndReregistrationFailsPending() throws Exception {
        assertThat(registry.sendToolRequest(1L, "tool", "{}", null, false, null).future().get())
                .contains("not connected");

        registry.setUserForSession(1L, 7L);
        when(wsRegistry.hasLocalClientConnection(7L)).thenReturn(true);
        CompletableFuture<String> pending = registry.sendToolRequest(1L, "tool", "{}", null, false, null).future();
        registry.setUserForSession(1L, 8L);
        assertThat(pending.get()).contains("re-registered");

        registry.setUserForSession(2L, 8L);
        when(wsRegistry.hasLocalClientConnection(8L)).thenReturn(true);
        CompletableFuture<String> pendingForUser = registry.sendToolRequest(2L, "tool", "{}", null, false, null).future();
        registry.failAllForUser(8L);
        assertThat(pendingForUser.get()).contains("User disconnected");

        registry.setUserForSession(3L, 9L);
        when(wsRegistry.hasLocalClientConnection(9L)).thenReturn(true);
        CompletableFuture<String> pendingForSession = registry.sendToolRequest(3L, "tool", "{}", null, false, null).future();
        registry.removeSession(3L);
        assertThat(pendingForSession.get()).contains("Session unregistered");
        registry.completeToolRequest(3L, "missing", "{}");
        registry.completeToolRequestError(3L, "missing", "err");
        registry.failAllForSession(3L);
    }
}
