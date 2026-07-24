package cn.etarch.mao.harness.local;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Executes tool calls on the user's local machine via WebSocket.
 * In LOCAL execution mode, tool requests are sent to the connected
 * desktop client (Electron) and results are awaited via CompletableFuture.
 */
@Slf4j
@Component
public class LocalToolExecutor {

    private final LocalToolSessionRegistry sessionRegistry;
    private final long timeoutSeconds;

    public LocalToolExecutor(LocalToolSessionRegistry sessionRegistry,
                             @Value("${app.harness.local-tool-timeout-seconds:900}") long timeoutSeconds) {
        this.sessionRegistry = sessionRegistry;
        this.timeoutSeconds = timeoutSeconds;
    }

    /**
     * Execute a tool call on the local client.
     *
     * @param sessionId    the session ID (used to find the connected WebSocket)
     * @param toolName     the tool to execute (shell, read_file, write_file, etc.)
     * @param arguments    JSON arguments string
     * @param needApproval whether the client should request user approval before executing
     * @param dangerReason why the tool was flagged as dangerous (nullable, only for SMART mode)
     * @return JSON result string, or JSON error if client is not connected
     */
    public String execute(Long sessionId, String toolName, String arguments, String workspace,
                          boolean needApproval, String dangerReason) {
        if (!sessionRegistry.isConnected(sessionId)) {
            log.warn("No local client connected for session {}", sessionId);
            return "{\"error\":\"Local client is not connected. Please ensure the desktop app is running and connected.\"}";
        }

        LocalToolSessionRegistry.PendingLocalToolRequest pending = null;
        try {
            pending = sessionRegistry.sendToolRequest(
                    sessionId, toolName, arguments, workspace, needApproval, dangerReason);
            return pending.future().get(timeoutSeconds, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            String timeoutMsg = "Local tool execution timed out after " + timeoutSeconds + " seconds";
            log.warn("Local tool execution timed out for session {}: tool={}, requestId={}, timeout={}s",
                    sessionId, toolName, pending != null ? pending.requestId() : null, timeoutSeconds);
            // Fail only this request — parallel tools in the same session must keep running.
            // failAllForSession remains for cancel / disconnect (session-level abort).
            failPending(sessionId, pending, timeoutMsg);
            return "{\"error\":\"" + timeoutMsg + "\"}";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            String msg = "Local tool execution interrupted";
            log.warn("Local tool execution interrupted for session {}: tool={}, requestId={}",
                    sessionId, toolName, pending != null ? pending.requestId() : null);
            failPending(sessionId, pending, msg);
            return "{\"error\":\"" + msg + "\"}";
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            String msg = "Local tool execution failed: " + cause.getMessage();
            log.error("Local tool execution failed for session {}: tool={}, requestId={}",
                    sessionId, toolName, pending != null ? pending.requestId() : null, cause);
            failPending(sessionId, pending, msg);
            return "{\"error\":\"" + escapeJson(msg) + "\"}";
        } catch (Exception e) {
            log.error("Local tool execution failed for session {}: tool={}, requestId={}",
                    sessionId, toolName, pending != null ? pending.requestId() : null, e);
            failPending(sessionId, pending, "Local tool execution failed: " + e.getMessage());
            return "{\"error\":\"Local tool execution failed: " + escapeJson(e.getMessage()) + "\"}";
        }
    }

    /**
     * Remove the pending future from the registry so it cannot leak after the waiter gives up.
     * No-op when the request was never registered ({@code requestId == null}).
     */
    private void failPending(Long sessionId,
                             LocalToolSessionRegistry.PendingLocalToolRequest pending,
                             String error) {
        if (pending != null && pending.requestId() != null) {
            sessionRegistry.completeToolRequestError(sessionId, pending.requestId(), error);
        }
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
