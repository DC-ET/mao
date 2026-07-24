package cn.etarch.mao.harness.local;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LocalToolExecutorTest {

    @Test
    void returnsErrorWhenLocalClientIsDisconnected() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(false);

        String result = new LocalToolExecutor(registry, 900)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("Local client is not connected");
    }

    @Test
    void returnsToolResultWhenRegistryFutureCompletes() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", true, "reason"))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest(
                        "req-1", CompletableFuture.completedFuture("{\"ok\":true}")));

        String result = new LocalToolExecutor(registry, 900)
                .execute(7L, "shell", "{}", "workspace", true, "reason");

        assertThat(result).isEqualTo("{\"ok\":true}");
        verify(registry, never()).failAllForSession(7L);
    }

    @Test
    void returnsTimeoutErrorAndFailsOnlyThatRequest() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        CompletableFuture<String> pending = new CompletableFuture<>();
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest("req-timeout", pending));

        String result = new LocalToolExecutor(registry, 1)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("timed out");
        verify(registry).completeToolRequestError(7L, "req-timeout",
                "Local tool execution timed out after 1 seconds");
        verify(registry, never()).failAllForSession(7L);
    }

    @Test
    void wrapsRegistryFailuresAsJsonError() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest(
                        "req-fail", CompletableFuture.failedFuture(new RuntimeException("boom"))));

        String result = new LocalToolExecutor(registry, 900)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("Local tool execution failed");
        verify(registry, never()).failAllForSession(7L);
    }
}
