package cn.etarch.mao.harness.core;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class BackgroundTaskManagerTest {

    @Test
    void consumesCompletedSuccessFailureAndTruncatedResults() throws Exception {
        BackgroundTaskManager manager = new BackgroundTaskManager();
        String ok = manager.submit(11L, () -> "done");
        String longTask = manager.submit(11L, () -> "x".repeat(600));
        String failed = manager.submit(11L, () -> {
            throw new IllegalStateException("boom");
        });

        Thread.sleep(100);
        Map<String, String> completed = manager.consumeCompletedResults(11L);

        assertThat(completed.get(ok)).isEqualTo("done");
        assertThat(completed.get(longTask)).endsWith("... [truncated]");
        assertThat(completed.get(failed)).contains("Error: boom");
        assertThat(manager.consumeCompletedResults(11L)).isEmpty();
    }

    @Test
    void consumeOnlyReturnsResultsForMatchingSession() throws Exception {
        BackgroundTaskManager manager = new BackgroundTaskManager();
        String forA = manager.submit(1L, () -> "from-a");
        String forB = manager.submit(2L, () -> "from-b");

        Thread.sleep(100);
        Map<String, String> consumedByB = manager.consumeCompletedResults(2L);

        assertThat(consumedByB).containsOnlyKeys(forB);
        assertThat(consumedByB.get(forB)).isEqualTo("from-b");

        Map<String, String> consumedByA = manager.consumeCompletedResults(1L);
        assertThat(consumedByA).containsOnlyKeys(forA);
        assertThat(consumedByA.get(forA)).isEqualTo("from-a");
    }

    @Test
    void consumeRemovesAllCompletedEntriesWithoutSkippingUnderManyTasks() throws Exception {
        BackgroundTaskManager manager = new BackgroundTaskManager();
        java.util.Set<String> ids = new java.util.LinkedHashSet<>();
        for (int i = 0; i < 50; i++) {
            ids.add(manager.submit(9L, () -> "ok"));
        }
        Thread.sleep(150);

        Map<String, String> first = manager.consumeCompletedResults(9L);
        assertThat(first.keySet()).containsExactlyInAnyOrderElementsOf(ids);
        assertThat(manager.consumeCompletedResults(9L)).isEmpty();
    }

    @Test
    void getResultHandlesMissingTimeoutSuccessAndFailure() {
        BackgroundTaskManager manager = new BackgroundTaskManager();

        assertThat(manager.getResult("missing", 0)).contains("task not found");

        String slow = manager.submit(7L, () -> {
            Thread.sleep(500);
            return "late";
        });
        assertThat(manager.getResult(slow, 0)).contains("timed out");

        String ok = manager.submit(7L, () -> "ok");
        assertThat(manager.getResult(ok, 1)).isEqualTo("ok");
        assertThat(manager.getResult(ok, 1)).contains("task not found");

        String failed = manager.submit(7L, () -> {
            throw new RuntimeException("bad");
        });
        assertThat(manager.getResult(failed, 1)).contains("Error: bad");
    }
}
