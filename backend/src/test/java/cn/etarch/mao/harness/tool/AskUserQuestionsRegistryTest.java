package cn.etarch.mao.harness.tool;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class AskUserQuestionsRegistryTest {

    private static final List<Map<String, Object>> QUESTIONS = List.of(
            Map.of("question", "如何处理?", "header", "方案", "multiSelect", false),
            Map.of("question", "是否需要?", "header", "范围", "multiSelect", true)
    );

    private static final Map<String, Object> METADATA = Map.of("source", "test");

    @Test
    void registerKeepsQuestionContentForPendingLookup() {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String requestId = registry.register(7L, QUESTIONS, METADATA);

        List<AskUserQuestionsRegistry.PendingQuestion> pending = registry.getPendingForSession(7L);

        assertThat(pending).hasSize(1);
        AskUserQuestionsRegistry.PendingQuestion question = pending.get(0);
        assertThat(question.requestId()).isEqualTo(requestId);
        assertThat(question.questions()).isEqualTo(QUESTIONS);
        assertThat(question.metadata()).isEqualTo(METADATA);
    }

    @Test
    void getPendingForSessionIsEmptyWhenNothingRegistered() {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();

        assertThat(registry.getPendingForSession(7L)).isEmpty();
        assertThat(registry.getPendingForSession(null)).isEmpty();
    }

    @Test
    void getPendingForSessionOnlyReturnsMatchingSession() {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        registry.register(7L, QUESTIONS, null);
        registry.register(8L, QUESTIONS, null);

        List<AskUserQuestionsRegistry.PendingQuestion> pending = registry.getPendingForSession(7L);

        assertThat(pending).hasSize(1);
        assertThat(pending.get(0).requestId()).isNotBlank();
    }

    @Test
    void registerWaitAndCompleteReturnsAnswer() throws Exception {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String requestId = registry.register(7L, QUESTIONS, null);

        CompletableFuture<String> waiting = CompletableFuture.supplyAsync(
                () -> registry.waitForAnswer(7L, requestId)
        );
        Thread.sleep(50);
        registry.complete(7L, requestId, "{\"answers\":[]}");

        assertThat(waiting.get(1, TimeUnit.SECONDS)).isEqualTo("{\"answers\":[]}");
    }

    @Test
    void completeRemovesPendingEntry() {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String requestId = registry.register(7L, QUESTIONS, null);

        assertThat(registry.complete(7L, requestId, "{\"answers\":[]}")).isTrue();

        assertThat(registry.getPendingForSession(7L)).isEmpty();
        // 二次 complete 返回 false（无 pending 可完成）
        assertThat(registry.complete(7L, requestId, "{\"answers\":[]}")).isFalse();
    }

    @Test
    void waitForUnknownRequestReturnsError() {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();

        assertThat(registry.waitForAnswer(7L, "missing")).contains("No pending question");
    }

    @Test
    void waitForAnswerTimesOutAndRemovesEntry() throws Exception {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry(50); // 50ms 超时
        String requestId = registry.register(7L, QUESTIONS, null);

        String result = registry.waitForAnswer(7L, requestId);

        assertThat(result).contains("did not respond within timeout");
        assertThat(registry.getPendingForSession(7L)).isEmpty();
    }

    @Test
    void failAllForSessionCompletesPendingQuestionsAndClears() throws Exception {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String first = registry.register(7L, QUESTIONS, null);
        String second = registry.register(8L, QUESTIONS, null);

        CompletableFuture<String> failed = CompletableFuture.supplyAsync(() -> registry.waitForAnswer(7L, first));
        Thread.sleep(50);
        registry.failAllForSession(7L);

        assertThat(failed.get(1, TimeUnit.SECONDS)).contains("Session cancelled");
        assertThat(registry.getPendingForSession(7L)).isEmpty();
        // 其它会话不受影响
        CompletableFuture<String> completed = CompletableFuture.supplyAsync(() -> registry.waitForAnswer(8L, second));
        Thread.sleep(50);
        registry.complete(8L, second, "{\"ok\":true}");
        assertThat(completed.get(1, TimeUnit.SECONDS)).isEqualTo("{\"ok\":true}");
    }

    @Test
    void failAllForSessionsCompletesAllGivenSessions() throws Exception {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String first = registry.register(7L, QUESTIONS, null);
        String second = registry.register(8L, QUESTIONS, null);

        CompletableFuture<String> failed1 = CompletableFuture.supplyAsync(() -> registry.waitForAnswer(7L, first));
        CompletableFuture<String> failed2 = CompletableFuture.supplyAsync(() -> registry.waitForAnswer(8L, second));
        Thread.sleep(50);
        registry.failAllForSessions(List.of(7L, 8L));

        assertThat(failed1.get(1, TimeUnit.SECONDS)).contains("Session cancelled");
        assertThat(failed2.get(1, TimeUnit.SECONDS)).contains("Session cancelled");
        assertThat(registry.getPendingForSession(7L)).isEmpty();
        assertThat(registry.getPendingForSession(8L)).isEmpty();
    }
}
