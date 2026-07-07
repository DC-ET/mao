package com.agentworkbench.harness.tool;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class AskUserQuestionsRegistryTest {

    @Test
    void registerWaitAndCompleteReturnsAnswer() throws Exception {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String requestId = registry.register(7L);

        CompletableFuture<String> waiting = CompletableFuture.supplyAsync(
                () -> registry.waitForAnswer(7L, requestId)
        );
        Thread.sleep(50);
        registry.complete(7L, requestId, "{\"answers\":[]}");

        assertThat(waiting.get(1, TimeUnit.SECONDS)).isEqualTo("{\"answers\":[]}");
    }

    @Test
    void waitForUnknownRequestReturnsError() {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();

        assertThat(registry.waitForAnswer(7L, "missing")).contains("No pending question");
    }

    @Test
    void failAllForSessionCompletesPendingQuestions() throws Exception {
        AskUserQuestionsRegistry registry = new AskUserQuestionsRegistry();
        String first = registry.register(7L);
        String second = registry.register(8L);

        CompletableFuture<String> failed = CompletableFuture.supplyAsync(() -> registry.waitForAnswer(7L, first));
        Thread.sleep(50);
        registry.failAllForSessions(List.of(7L));

        assertThat(failed.get(1, TimeUnit.SECONDS)).contains("Session cancelled");
        CompletableFuture<String> completed = CompletableFuture.supplyAsync(() -> registry.waitForAnswer(8L, second));
        Thread.sleep(50);
        registry.complete(8L, second, "{\"ok\":true}");
        assertThat(completed.get(1, TimeUnit.SECONDS)).isEqualTo("{\"ok\":true}");
    }
}
