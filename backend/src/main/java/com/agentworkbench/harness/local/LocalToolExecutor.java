package com.agentworkbench.harness.local;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * Executes tool calls on the user's local machine via WebSocket.
 * In LOCAL execution mode, tool requests are sent to the connected
 * desktop client (Electron) and results are awaited via CompletableFuture.
 */
@Slf4j
@Component
public class LocalToolExecutor {

    private final LocalToolSessionRegistry sessionRegistry;

    public LocalToolExecutor(LocalToolSessionRegistry sessionRegistry) {
        this.sessionRegistry = sessionRegistry;
    }

    /**
     * Execute a tool call on the local client.
     *
     * @param sessionId the session ID (used to find the connected WebSocket)
     * @param toolName  the tool to execute (bash, read_file, write_file, etc.)
     * @param arguments JSON arguments string
     * @return JSON result string, or JSON error if client is not connected / timed out
     */
    public String execute(Long sessionId, String toolName, String arguments) {
        if (!sessionRegistry.isConnected(sessionId)) {
            log.warn("No local client connected for session {}", sessionId);
            return "{\"error\":\"Local client is not connected. Please ensure the desktop app is running and connected.\"}";
        }

        try {
            String result = sessionRegistry.sendToolRequest(sessionId, toolName, arguments).get(60, java.util.concurrent.TimeUnit.SECONDS);
            return result;
        } catch (java.util.concurrent.TimeoutException e) {
            log.warn("Local tool execution timed out for session {}: tool={}", sessionId, toolName);
            return "{\"error\":\"Local tool execution timed out (60s). The desktop client may be unresponsive.\"}";
        } catch (Exception e) {
            log.error("Local tool execution failed for session {}: tool={}", sessionId, toolName, e);
            return "{\"error\":\"Local tool execution failed: " + e.getMessage() + "\"}";
        }
    }
}
