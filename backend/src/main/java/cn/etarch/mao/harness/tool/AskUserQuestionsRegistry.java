package cn.etarch.mao.harness.tool;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Manages pending ask_user_questions requests.
 * When the agent calls ask_user_questions, a CompletableFuture is registered here
 * and completed when the user responds via WebSocket.
 *
 * <p>Each pending entry also keeps the original question content (questions + metadata),
 * so that on client reconnect the question can be re-pushed to restore the question panel.</p>
 */
@Slf4j
@Component
public class AskUserQuestionsRegistry {

    private static final long DEFAULT_TIMEOUT_MILLIS = 900_000; // 15 minutes

    private final long timeoutMillis;

    public AskUserQuestionsRegistry() {
        this(DEFAULT_TIMEOUT_MILLIS);
    }

    /** 仅测试用：注入自定义超时毫秒数。 */
    AskUserQuestionsRegistry(long timeoutMillis) {
        this.timeoutMillis = timeoutMillis;
    }

    /**
     * A pending ask_user_questions request: the completion future plus the original
     * question content needed to re-push the question after a client reconnect.
     */
    public record PendingQuestion(
            String requestId,
            List<Map<String, Object>> questions,
            Map<String, Object> metadata) {}

    private record PendingEntry(CompletableFuture<String> future,
                                List<Map<String, Object>> questions,
                                Map<String, Object> metadata) {}

    /** sessionId:requestId → pending 询问（future + 原问题内容） */
    private final ConcurrentHashMap<String, PendingEntry> pending = new ConcurrentHashMap<>();

    /**
     * Register a new pending question and return the requestId.
     * Keeps the original question content so the question can be re-pushed on reconnect.
     */
    public String register(Long sessionId, List<Map<String, Object>> questions, Map<String, Object> metadata) {
        String requestId = UUID.randomUUID().toString();
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(key(sessionId, requestId), new PendingEntry(future, questions, metadata));
        log.debug("Registered ask_user_questions request {} for session {}", requestId, sessionId);
        return requestId;
    }

    /**
     * Wait for the user's answer with a timeout.
     *
     * @return the user's answer as JSON, or a timeout error JSON
     */
    public String waitForAnswer(Long sessionId, String requestId) {
        PendingEntry entry = pending.get(key(sessionId, requestId));
        if (entry == null) {
            return "{\"error\": \"No pending question found for requestId: " + requestId + "\"}";
        }
        try {
            return entry.future().get(timeoutMillis, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            pending.remove(key(sessionId, requestId));
            log.warn("ask_user_questions timeout for session {}, requestId {}", sessionId, requestId);
            return "{\"error\": \"User did not respond within timeout\"}";
        }
    }

    /**
     * Complete a pending question with the user's answer.
     *
     * @return true if a pending question was actually completed, false if the
     *         requestId was unknown or already completed (e.g. stale answer)
     */
    public boolean complete(Long sessionId, String requestId, String result) {
        PendingEntry entry = pending.remove(key(sessionId, requestId));
        if (entry != null) {
            entry.future().complete(result);
            log.debug("Completed ask_user_questions request {} for session {}", requestId, sessionId);
            return true;
        }
        return false;
    }

    /**
     * Return all pending (unanswered) questions for a session, e.g. to re-push
     * them to the client after a WebSocket reconnect or page refresh.
     */
    public List<PendingQuestion> getPendingForSession(Long sessionId) {
        if (sessionId == null) {
            return List.of();
        }
        String prefix = sessionId + ":";
        List<PendingQuestion> result = new ArrayList<>();
        pending.forEach((key, entry) -> {
            if (key.startsWith(prefix)) {
                String requestId = key.substring(prefix.length());
                result.add(new PendingQuestion(requestId, entry.questions(), entry.metadata()));
            }
        });
        return result;
    }

    /**
     * Fail all pending questions for a session (e.g. on cancel).
     */
    public void failAllForSession(Long sessionId) {
        String prefix = sessionId + ":";
        pending.entrySet().removeIf(entry -> {
            if (entry.getKey().startsWith(prefix)) {
                entry.getValue().future().complete("{\"error\": \"Session cancelled\"}");
                return true;
            }
            return false;
        });
    }

    /**
     * Fail all pending questions for all given sessions.
     */
    public void failAllForSessions(Collection<Long> sessionIds) {
        for (Long sessionId : sessionIds) {
            failAllForSession(sessionId);
        }
    }

    private String key(Long sessionId, String requestId) {
        return sessionId + ":" + requestId;
    }
}
