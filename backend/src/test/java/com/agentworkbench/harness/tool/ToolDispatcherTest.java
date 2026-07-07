package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.local.LocalToolExecutor;
import com.agentworkbench.harness.local.LocalToolSessionRegistry;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.session.ws.StreamingWsRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ToolDispatcherTest {

    private final Tool serverTool = mockTool("task_create");
    private final Tool cloudTool = mockTool("read_file");
    private final ToolRegistry registry = new ToolRegistry(List.of(serverTool, cloudTool));
    private final LocalToolExecutor localToolExecutor = mock(LocalToolExecutor.class);
    private final DangerAssessor dangerAssessor = mock(DangerAssessor.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final StreamingWsRegistry streamingWsRegistry = mock(StreamingWsRegistry.class);
    private final AskUserQuestionsRegistry askUserQuestionsRegistry = mock(AskUserQuestionsRegistry.class);
    private final LocalToolSessionRegistry localToolSessionRegistry = mock(LocalToolSessionRegistry.class);
    private final ToolDispatcher dispatcher = new ToolDispatcher(
            registry,
            localToolExecutor,
            dangerAssessor,
            sessionMapper,
            streamingWsRegistry,
            askUserQuestionsRegistry,
            localToolSessionRegistry,
            new ObjectMapper()
    );

    @Test
    void dispatchesCloudModeToBuiltInToolWithWorkspace() {
        when(cloudTool.execute("{}", "workspace")).thenReturn("cloud-result");

        String result = dispatcher.dispatch("read_file", "{}", "workspace");

        assertThat(result).isEqualTo("cloud-result");
    }

    @Test
    void dispatchesServerOnlyToolsOnServerEvenInLocalMode() {
        when(serverTool.execute("{}", 7L, 9L, "workspace")).thenReturn("server-result");

        String result = dispatcher.dispatch("task_create", "{}", "LOCAL", 7L, 9L,
                "workspace", "FULL", null);

        assertThat(result).isEqualTo("server-result");
        verify(localToolExecutor, never()).execute(any(), any(), any(), any(), eq(false), any());
    }

    @Test
    void localReadOnlyRequiresApprovalForWriteAndShellTools() {
        when(localToolExecutor.execute(7L, "read_file", "{}", "workspace", false, null)).thenReturn("read");
        when(localToolExecutor.execute(7L, "write_file", "{}", "workspace", true, null)).thenReturn("write");

        assertThat(dispatcher.dispatch("read_file", "{}", "LOCAL", 7L, "workspace", "READ_ONLY", null))
                .isEqualTo("read");
        assertThat(dispatcher.dispatch("write_file", "{}", "LOCAL", 7L, "workspace", "READ_ONLY", null))
                .isEqualTo("write");
    }

    @Test
    void localModeUsesLatestPermissionLevelFromSession() {
        Session session = new Session();
        session.setPermissionLevel("FULL");
        when(sessionMapper.selectById(7L)).thenReturn(session);
        when(localToolExecutor.execute(7L, "shell", "{}", "workspace", false, null)).thenReturn("ok");

        String result = dispatcher.dispatch("shell", "{}", "LOCAL", 7L, "workspace", "READ_ONLY", null);

        assertThat(result).isEqualTo("ok");
    }

    @Test
    void smartModeUsesDangerAssessorForShellCommands() {
        LlmModelConfig modelConfig = LlmModelConfig.builder().modelId("test").build();
        when(dangerAssessor.assess("{}", modelConfig))
                .thenReturn(new DangerAssessor.DangerResult(true, "危险"));
        when(localToolExecutor.execute(7L, "shell", "{}", "workspace", true, "危险")).thenReturn("needs-approval");

        String result = dispatcher.dispatch("shell", "{}", "LOCAL", 7L, "workspace", "SMART", modelConfig);

        assertThat(result).isEqualTo("needs-approval");
    }

    @Test
    void smartModeRequiresApprovalWhenModelConfigMissing() {
        when(localToolExecutor.execute(eq(7L), eq("shell"), eq("{}"), eq("workspace"), eq(true), any()))
                .thenReturn("needs-approval");

        String result = dispatcher.dispatch("shell", "{}", "LOCAL", 7L, "workspace", "SMART", null);

        assertThat(result).isEqualTo("needs-approval");
    }

    @Test
    void askUserQuestionsRoutesThroughConnectedClientAndCancelsOnError() {
        when(localToolSessionRegistry.getUserIdForSession(7L)).thenReturn(9L);
        when(streamingWsRegistry.hasConnection(9L)).thenReturn(true);
        when(askUserQuestionsRegistry.register(7L)).thenReturn("req-1");
        when(askUserQuestionsRegistry.waitForAnswer(7L, "req-1")).thenReturn("{\"error\":\"timeout\"}");

        String result = dispatcher.dispatch("ask_user_questions",
                "{\"questions\":[{\"id\":\"q1\"}],\"metadata\":{\"source\":\"test\"}}",
                "CLOUD", 7L, "workspace");

        assertThat(result).contains("timeout");
        verify(streamingWsRegistry, times(2)).send(eq(9L), any());
        verify(askUserQuestionsRegistry).waitForAnswer(7L, "req-1");
    }

    @Test
    void askUserQuestionsFallsBackToSessionLookupAndReportsMissingClient() {
        Session session = new Session();
        session.setUserId(9L);
        when(localToolSessionRegistry.getUserIdForSession(7L)).thenReturn(null);
        when(sessionMapper.selectById(7L)).thenReturn(session);
        when(streamingWsRegistry.hasConnection(9L)).thenReturn(false);

        String result = dispatcher.dispatch("ask_user_questions", "{}", "CLOUD", 7L, "workspace");

        assertThat(result).contains("No connected client");
    }

    @Test
    void unknownToolThrowsException() {
        assertThatThrownBy(() -> dispatcher.dispatch("missing", "{}"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unknown tool");
    }

    private Tool mockTool(String name) {
        Tool tool = mock(Tool.class);
        when(tool.getName()).thenReturn(name);
        return tool;
    }
}
