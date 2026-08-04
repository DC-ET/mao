package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionHistoryLoaderTest {

    @Mock private SessionService sessionService;
    @Mock private ContextManager contextManager;
    @Spy private ObjectMapper objectMapper = new ObjectMapper();
    @InjectMocks private SessionHistoryLoader loader;

    @Test
    void applyHistoryRestoresEphemeralSystemMessagesAtTail() {
        AgentExecutionContext context = new AgentExecutionContext();
        List<ChatRequest.Message> messagesRef = context.getMessages();
        context.addSystemMessage("background task result");
        assertThat(context.getEphemeralSystemMessages()).hasSize(1);

        when(contextManager.prependSessionSummary(any(), anyList())).thenAnswer(inv -> {
            String summary = inv.getArgument(0);
            List<ChatRequest.Message> increment = inv.getArgument(1);
            List<ChatRequest.Message> result = new ArrayList<>();
            if (summary != null) {
                result.add(ChatRequest.Message.builder().role("system").content(summary).build());
            }
            result.addAll(increment);
            return result;
        });

        Message user = new Message();
        user.setId(10L);
        user.setRole("USER");
        user.setContent("hello");
        List<PersistedChatMessage> persisted = List.of(new PersistedChatMessage(10L,
                ChatRequest.Message.builder().role("user").content("hello").build()));
        SessionHistoryLoader.HistorySnapshot history =
                new SessionHistoryLoader.HistorySnapshot(List.of(10L), List.of(user), persisted);

        loader.applyHistory(context, "summary text", history);

        assertThat(context.getMessages()).isSameAs(messagesRef);
        assertThat(context.getMessages()).extracting(ChatRequest.Message::getRole)
                .containsExactly("system", "user", "system");
        assertThat(context.getMessages().get(2).getContent().toString())
                .contains("background task result");
        assertThat(context.getSessionSummary()).isEqualTo("summary text");
    }

    @Test
    void loadHistoryAfterBoundaryBuildsPersistedMessages() {
        Message user = new Message();
        user.setId(5L);
        user.setRole("USER");
        user.setContent("hi");
        when(sessionService.getMessagesAfterId(3L, 0L)).thenReturn(List.of(user));

        SessionHistoryLoader.HistorySnapshot snapshot = loader.loadHistoryAfterBoundary(3L, 0L);

        assertThat(snapshot.snapshotMessageIds()).containsExactly(5L);
        assertThat(snapshot.persistedMessages()).hasSize(1);
        assertThat(snapshot.persistedMessages().get(0).chatMessage().getRole()).isEqualTo("user");
    }
}
