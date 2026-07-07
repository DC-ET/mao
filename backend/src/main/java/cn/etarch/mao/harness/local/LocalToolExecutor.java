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
            return sessionRegistry.sendToolRequest(sessionId, toolName, arguments, workspace, needApproval, dangerReason)
                    .get(timeoutSeconds, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            log.warn("Local tool execution timed out for session {}: tool={}, timeout={}s",
                    sessionId, toolName, timeoutSeconds);
            sessionRegistry.failAllForSession(sessionId);
            return "{\"error\":\"Local tool execution timed out after " + timeoutSeconds + " seconds\"}";
        } catch (Exception e) {
            log.error("Local tool execution failed for session {}: tool={}", sessionId, toolName, e);
            return "{\"error\":\"Local tool execution failed: " + e.getMessage() + "\"}";
        }
    }
}
