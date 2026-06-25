package com.agentworkbench.harness.tool;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Manages pending ask_user_questions requests.
 * When the agent calls ask_user_questions, a CompletableFuture is registered here
 * and completed when the user responds via WebSocket.
 */
@Slf4j
@Component
public class AskUserQuestionsRegistry {

    private static final long DEFAULT_TIMEOUT_SECONDS = 30; // 5 minutes

    /** sessionId:requestId → CompletableFuture */
    private final ConcurrentHashMap<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();

    /**
     * Register a new pending question and return the requestId.
     */
    public String register(Long sessionId) {
        String requestId = UUID.randomUUID().toString();
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(key(sessionId, requestId), future);
        log.debug("Registered ask_user_questions request {} for session {}", requestId, sessionId);
        return requestId;
    }

    /**
     * Wait for the user's answer with a timeout.
     *
     * @return the user's answer as JSON, or a timeout error JSON
     */
    public String waitForAnswer(Long sessionId, String requestId) {
        CompletableFuture<String> future = pending.get(key(sessionId, requestId));
        if (future == null) {
            return "{\"error\": \"No pending question found for requestId: " + requestId + "\"}";
        }
        try {
            return future.get(DEFAULT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception e) {
            pending.remove(key(sessionId, requestId));
            log.warn("ask_user_questions timeout for session {}, requestId {}", sessionId, requestId);
            return "{\"error\": \"User did not respond within timeout\"}";
        }
    }

    /**
     * Complete a pending question with the user's answer.
     */
    public void complete(Long sessionId, String requestId, String result) {
        CompletableFuture<String> future = pending.remove(key(sessionId, requestId));
        if (future != null) {
            future.complete(result);
            log.debug("Completed ask_user_questions request {} for session {}", requestId, sessionId);
        }
    }

    /**
     * Fail all pending questions for a session (e.g. on cancel).
     */
    public void failAllForSession(Long sessionId) {
        String prefix = sessionId + ":";
        pending.entrySet().removeIf(entry -> {
            if (entry.getKey().startsWith(prefix)) {
                entry.getValue().complete("{\"error\": \"Session cancelled\"}");
                return true;
            }
            return false;
        });
    }

    private String key(Long sessionId, String requestId) {
        return sessionId + ":" + requestId;
    }
}
