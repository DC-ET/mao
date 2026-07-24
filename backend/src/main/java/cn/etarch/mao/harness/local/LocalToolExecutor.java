package cn.etarch.mao.harness.local;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

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

        try {
            var pending = sessionRegistry.sendToolRequest(
                    sessionId, toolName, arguments, workspace, needApproval, dangerReason);
            try {
                return pending.future().get(timeoutSeconds, TimeUnit.SECONDS);
            } catch (TimeoutException e) {
                log.warn("Local tool execution timed out for session {}: tool={}, requestId={}, timeout={}s",
                        sessionId, toolName, pending.requestId(), timeoutSeconds);
                // Fail only this request — parallel tools in the same session must keep running.
                // failAllForSession remains for cancel / disconnect (session-level abort).
                String timeoutMsg = "Local tool execution timed out after " + timeoutSeconds + " seconds";
                if (pending.requestId() != null) {
                    sessionRegistry.completeToolRequestError(sessionId, pending.requestId(), timeoutMsg);
                }
                return "{\"error\":\"" + timeoutMsg + "\"}";
            }
        } catch (Exception e) {
            log.error("Local tool execution failed for session {}: tool={}", sessionId, toolName, e);
            return "{\"error\":\"Local tool execution failed: " + e.getMessage() + "\"}";
        }
    }
}
