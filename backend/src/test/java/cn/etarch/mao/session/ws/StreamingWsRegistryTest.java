package cn.etarch.mao.session.ws;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class StreamingWsRegistryTest {
    private final StreamingWsRegistry registry = new StreamingWsRegistry(10);

    @AfterEach
    void tearDown() {
        registry.shutdown();
    }

    @Test
    void reportsNoDeliveryWithoutConnections() throws Exception {
        StreamingWsRegistry.WsDeliveryResult result = registry
                .sendWithResult(1L, WsEvent.of("session_status", 10L, java.util.Map.of("phase", "COMPLETED")))
                .get(2, TimeUnit.SECONDS);
        assertFalse(result.delivered());
        assertEquals(0, result.targetCount());
    }

    @Test
    void reportsSuccessWhenAnyOpenConnectionAcceptsMessage() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("ws-1");
        when(session.isOpen()).thenReturn(true);
        registry.register(session, 1L, "electron");

        StreamingWsRegistry.WsDeliveryResult result = registry
                .sendWithResult(1L, WsEvent.of("session_status", 10L, java.util.Map.of("phase", "COMPLETED")))
                .get(2, TimeUnit.SECONDS);
        assertTrue(result.delivered());
        assertEquals(1, result.successCount());
    }

    @Test
    void reportsFailureWhenAllWritesFail() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("ws-2");
        when(session.isOpen()).thenReturn(true);
        doThrow(new java.io.IOException("closed")).when(session).sendMessage(any());
        registry.register(session, 1L, "electron");

        StreamingWsRegistry.WsDeliveryResult result = registry
                .sendWithResult(1L, WsEvent.of("session_status", 10L, java.util.Map.of("phase", "FAILED")))
                .get(2, TimeUnit.SECONDS);
        assertFalse(result.delivered());
        assertEquals(1, result.failureCount());
    }
}
