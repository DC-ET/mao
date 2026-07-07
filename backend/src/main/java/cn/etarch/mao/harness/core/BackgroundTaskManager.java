package cn.etarch.mao.harness.core;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.*;

/**
 * Manages background tasks for async tool execution (e.g., long-running shell commands).
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

    private final Map<String, Future<String>> tasks = new ConcurrentHashMap<>();
    private final Map<String, Long> taskSubmitTimes = new ConcurrentHashMap<>();

    /**
     * Submit a task for background execution.
     * Returns a taskId for later retrieval.
     */
    public String submit(Callable<String> task) {
        String taskId = "bg-" + System.nanoTime();
        Future<String> future = executor.submit(task);
        tasks.put(taskId, future);
        taskSubmitTimes.put(taskId, System.currentTimeMillis());
        log.debug("Submitted background task: {}", taskId);
        return taskId;
    }

    /**
     * Get results of all completed tasks, removing them from the map.
     */
    public Map<String, String> consumeCompletedResults() {
        Map<String, String> completed = new ConcurrentHashMap<>();
        long now = System.currentTimeMillis();
        tasks.forEach((taskId, future) -> {
            if (future.isDone()) {
                try {
                    String result = future.get(0, TimeUnit.SECONDS);
                    if (result.length() > MAX_OUTPUT_LENGTH) {
                        result = result.substring(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
                    }
                    completed.put(taskId, result);
                } catch (ExecutionException e) {
                    completed.put(taskId, "Error: " + e.getCause().getMessage());
                } catch (TimeoutException | InterruptedException e) {
                    // not ready yet, skip
                }
                tasks.remove(taskId);
                taskSubmitTimes.remove(taskId);
            } else {
                // Cancel abandoned tasks that have been running too long
                Long submitTime = taskSubmitTimes.get(taskId);
                if (submitTime != null && (now - submitTime) > ABANDONED_THRESHOLD_MS) {
                    future.cancel(true);
                    tasks.remove(taskId);
                    taskSubmitTimes.remove(taskId);
                    log.warn("Cancelled abandoned background task: {}", taskId);
                }
            }
        });
        return completed;
    }

    /**
     * Get result of a specific task (blocking with timeout).
     */
    public String getResult(String taskId, int timeoutSeconds) {
        Future<String> future = tasks.get(taskId);
        if (future == null) {
            return "Error: task not found: " + taskId;
        }
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
            return "Error: " + e.getCause().getMessage();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "Error: interrupted";
        }
    }
}
