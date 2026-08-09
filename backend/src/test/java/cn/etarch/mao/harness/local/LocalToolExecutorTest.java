package cn.etarch.mao.harness.local;

import cn.etarch.mao.harness.approval.ApprovalRegistry;
import cn.etarch.mao.harness.approval.SessionTreeSignalPublisher;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LocalToolExecutorTest {

    private final ApprovalRegistry approvalRegistry = mock(ApprovalRegistry.class);
    private final SessionTreeSignalPublisher treeSignalPublisher = mock(SessionTreeSignalPublisher.class);

    private LocalToolExecutor executor(LocalToolSessionRegistry registry, long timeoutSeconds) {
        return new LocalToolExecutor(registry, approvalRegistry, treeSignalPublisher, timeoutSeconds);
    }

    @Test
    void returnsErrorWhenLocalClientIsDisconnected() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(false);

        String result = executor(registry, 900)
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

        String result = executor(registry, 900)
                .execute(7L, "shell", "{}", "workspace", true, "reason");

        assertThat(result).isEqualTo("{\"ok\":true}");
        verify(registry, never()).failAllForSession(7L);
        verify(registry, never()).completeToolRequestError(eq(7L), eq("req-1"), org.mockito.ArgumentMatchers.anyString());
    }

    @Test
    void registersAndUnregistersApprovalForApprovalRequests() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", true, "reason"))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest(
                        "req-1", CompletableFuture.completedFuture("{\"ok\":true}")));

        executor(registry, 900).execute(7L, "shell", "{}", "workspace", true, "reason");

        // 需要审批的请求：登记 + 审批结束后注销；并在登记/注销时各刷新一次任务树信号（主/边路统一分流）
        verify(approvalRegistry).register(7L, "req-1");
        verify(approvalRegistry).unregister(7L, "req-1");
        verify(treeSignalPublisher, times(2)).publishForSession(7L);
    }

    @Test
    void doesNotRegisterApprovalForNonApprovalRequests() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest(
                        "req-1", CompletableFuture.completedFuture("{\"ok\":true}")));

        executor(registry, 900).execute(7L, "shell", "{}", "workspace", false, null);

        verify(approvalRegistry, never()).register(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        verify(approvalRegistry, never()).unregister(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        verify(treeSignalPublisher, never()).publishForSession(7L);
    }

    @Test
    void unregistersApprovalEvenOnTimeout() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        CompletableFuture<String> pending = new CompletableFuture<>();
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", true, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest("req-timeout", pending));

        String result = executor(registry, 1)
                .execute(7L, "shell", "{}", "workspace", true, null);

        assertThat(result).contains("timed out");
        verify(registry).completeToolRequestError(7L, "req-timeout",
                "Local tool execution timed out after 1 seconds");
        verify(registry, never()).failAllForSession(7L);
        // 超时也必须注销审批（finally 兜底）
        verify(approvalRegistry).unregister(7L, "req-timeout");
        verify(treeSignalPublisher, times(2)).publishForSession(7L);
    }

    @Test
    void returnsTimeoutErrorAndFailsOnlyThatRequest() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        CompletableFuture<String> pending = new CompletableFuture<>();
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest("req-timeout", pending));

        String result = executor(registry, 1)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("timed out");
        verify(registry).completeToolRequestError(7L, "req-timeout",
                "Local tool execution timed out after 1 seconds");
        verify(registry, never()).failAllForSession(7L);
    }

    @Test
    void cleansUpPendingRequestWhenFutureCompletesExceptionally() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest(
                        "req-fail", CompletableFuture.failedFuture(new RuntimeException("boom"))));

        String result = executor(registry, 900)
                .execute(7L, "shell", "{}", "workspace", false, null);

        assertThat(result).contains("Local tool execution failed");
        verify(registry).completeToolRequestError(eq(7L), eq("req-fail"), startsWith("Local tool execution failed:"));
        verify(registry, never()).failAllForSession(7L);
    }

    @Test
    void cleansUpPendingRequestWhenWaitIsInterrupted() {
        LocalToolSessionRegistry registry = mock(LocalToolSessionRegistry.class);
        when(registry.isConnected(7L)).thenReturn(true);
        CompletableFuture<String> pending = new CompletableFuture<>();
        when(registry.sendToolRequest(7L, "shell", "{}", "workspace", false, null))
                .thenReturn(new LocalToolSessionRegistry.PendingLocalToolRequest("req-interrupt", pending));

        Thread.currentThread().interrupt();
        try {
            String result = executor(registry, 900)
                    .execute(7L, "shell", "{}", "workspace", false, null);

            assertThat(result).contains("interrupted");
            verify(registry).completeToolRequestError(7L, "req-interrupt", "Local tool execution interrupted");
            verify(registry, never()).failAllForSession(7L);
        } finally {
            // Consume interrupt status left by the executor under test
            Thread.interrupted();
        }
    }
}
