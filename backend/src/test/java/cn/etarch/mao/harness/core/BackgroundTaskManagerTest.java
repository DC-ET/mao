package cn.etarch.mao.harness.core;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class BackgroundTaskManagerTest {

    @Test
    void consumesCompletedSuccessFailureAndTruncatedResults() throws Exception {
        BackgroundTaskManager manager = new BackgroundTaskManager();
        String ok = manager.submit(() -> "done");
        String longTask = manager.submit(() -> "x".repeat(600));
        String failed = manager.submit(() -> {
            throw new IllegalStateException("boom");
        });

        Thread.sleep(100);
        Map<String, String> completed = manager.consumeCompletedResults();

        assertThat(completed.get(ok)).isEqualTo("done");
        assertThat(completed.get(longTask)).endsWith("... [truncated]");
        assertThat(completed.get(failed)).contains("Error: boom");
        assertThat(manager.consumeCompletedResults()).isEmpty();
    }

    @Test
    void getResultHandlesMissingTimeoutSuccessAndFailure() {
        BackgroundTaskManager manager = new BackgroundTaskManager();

        assertThat(manager.getResult("missing", 0)).contains("task not found");

        String slow = manager.submit(() -> {
            Thread.sleep(500);
            return "late";
        });
        assertThat(manager.getResult(slow, 0)).contains("timed out");

        String ok = manager.submit(() -> "ok");
        assertThat(manager.getResult(ok, 1)).isEqualTo("ok");
        assertThat(manager.getResult(ok, 1)).contains("task not found");

        String failed = manager.submit(() -> {
            throw new RuntimeException("bad");
        });
        assertThat(manager.getResult(failed, 1)).contains("Error: bad");
    }
}
