package cn.etarch.mao.harness.core;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.*;

/**
 * Manages background tasks for async tool execution (e.g., long-running shell commands).
 * Tasks are partitioned by agent sessionId so one AgentLoop cannot consume another's results.
 */
@Slf4j
@Component
public class BackgroundTaskManager {

    private static final int MAX_OUTPUT_LENGTH = 500;
    /** Abandoned tasks older than this are cleaned up on next consume() call */
    private static final long ABANDONED_THRESHOLD_MS = 30 * 60 * 1000L; // 30 minutes

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "bg-task-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    private record TaskEntry(Long sessionId, Future<String> future, long submitTimeMs) {}

    private final Map<String, TaskEntry> tasks = new ConcurrentHashMap<>();

    /**
     * Submit a task for background execution scoped to an agent session.
     * Returns a taskId for later retrieval.
     */
    public String submit(Long sessionId, Callable<String> task) {
        String taskId = "bg-" + System.nanoTime();
        Future<String> future = executor.submit(task);
        tasks.put(taskId, new TaskEntry(sessionId, future, System.currentTimeMillis()));
        log.debug("Submitted background task: {} for session={}", taskId, sessionId);
        return taskId;
    }

    /**
     * Get results of completed tasks for the given session only, removing them from the map.
     * Also cancels abandoned tasks (any session) that exceed {@link #ABANDONED_THRESHOLD_MS}.
     */
    public Map<String, String> consumeCompletedResults(Long sessionId) {
        Map<String, String> completed = new ConcurrentHashMap<>();
        long now = System.currentTimeMillis();
        tasks.forEach((taskId, entry) -> {
            Future<String> future = entry.future();
            if (future.isDone()) {
                if (!Objects.equals(sessionId, entry.sessionId())) {
                    // Leave for the owning session's AgentLoop to consume
                    return;
                }
                try {
                    String result = future.get(0, TimeUnit.SECONDS);
                    if (result.length() > MAX_OUTPUT_LENGTH) {
                        result = result.substring(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
                    }
                    completed.put(taskId, result);
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    completed.put(taskId, "Error: " + cause.getMessage());
                } catch (TimeoutException | InterruptedException e) {
                    // not ready yet, skip
                    return;
                }
                tasks.remove(taskId);
            } else if ((now - entry.submitTimeMs()) > ABANDONED_THRESHOLD_MS) {
                future.cancel(true);
                tasks.remove(taskId);
                log.warn("Cancelled abandoned background task: {} session={}", taskId, entry.sessionId());
            }
        });
        return completed;
    }

    /**
     * Get result of a specific task (blocking with timeout).
     */
    public String getResult(String taskId, int timeoutSeconds) {
        TaskEntry entry = tasks.get(taskId);
        if (entry == null) {
            return "Error: task not found: " + taskId;
        }
        Future<String> future = entry.future();
        try {
            String result = future.get(timeoutSeconds, TimeUnit.SECONDS);
            tasks.remove(taskId);
            if (result.length() > MAX_OUTPUT_LENGTH) {
                result = result.substring(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
            }
            return result;
        } catch (TimeoutException e) {
            return "Error: task timed out after " + timeoutSeconds + " seconds";
        } catch (ExecutionException e) {
            tasks.remove(taskId);
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return "Error: " + cause.getMessage();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "Error: interrupted";
        }
    }
}
