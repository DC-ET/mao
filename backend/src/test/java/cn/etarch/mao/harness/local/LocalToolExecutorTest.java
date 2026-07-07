package cn.etarch.mao.harness.local;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class LocalToolExecutorTest {

    @Test
    void returnsErrorWhenLocalClientIsDisconnected() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(false);

        String result = new LocalToolExecutor(registry)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("Local client is not connected");
    }

    @Test
    void returnsToolResultWhenRegistryFutureCompletes() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", true, "reason"))
                .thenReturn(CompletableFuture.completedFuture("{\"ok\":true}"));

        String result = new LocalToolExecutor(registry)
                .execute(7L, "shell", "{}", "workspace", true, "reason");

        assertThat(result).isEqualTo("{\"ok\":true}");
    }

    @Test
    void wrapsRegistryFailuresAsJsonError() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(CompletableFuture.failedFuture(new RuntimeException("boom")));

        String result = new LocalToolExecutor(registry)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("Local tool execution failed");
    }
}
