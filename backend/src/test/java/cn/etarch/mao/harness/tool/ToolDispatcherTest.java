package cn.etarch.mao.harness.tool;

import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.harness.local.LocalToolExecutor;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ToolDispatcherTest {

    private final Tool serverTool = mockTool("task_create");
    private final Tool cloudTool = mockTool("read_file");
    private final Tool mcpTool = mockTool("mcp__filesystem__write_file");
    private final ToolRegistry registry = new ToolRegistry(List.of(serverTool, cloudTool, mcpTool));
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

    // ── MCP 工具（mcp__ 前缀）审批规则 ──────────────────────────────

    @Test
    void localMcpToolRequiresApprovalForReadOnlyLevel() {
        when(localToolExecutor.execute(7L, "mcp__filesystem__write_file", "{}", "workspace", true, null))
                .thenReturn("executed");

        String result = dispatcher.dispatch("mcp__filesystem__write_file", "{}", "LOCAL", 7L,
                "workspace", "READ_ONLY", null);

        assertThat(result).isEqualTo("executed");
    }

    @Test
    void localMcpToolRequiresApprovalForReadWriteLevel() {
        when(localToolExecutor.execute(7L, "mcp__filesystem__write_file", "{}", "workspace", true, null))
                .thenReturn("executed");

        String result = dispatcher.dispatch("mcp__filesystem__write_file", "{}", "LOCAL", 7L,
                "workspace", "READ_WRITE", null);

        assertThat(result).isEqualTo("executed");
    }

    @Test
    void localMcpToolRequiresApprovalForSmartLevelWithoutDangerAssessor() {
        // SMART 模式下 MCP 工具直接审批，不做 AI 危险评估
        when(localToolExecutor.execute(eq(7L), eq("mcp__filesystem__write_file"), eq("{}"),
                eq("workspace"), eq(true), any())).thenReturn("executed");

        String result = dispatcher.dispatch("mcp__filesystem__write_file", "{}", "LOCAL", 7L,
                "workspace", "SMART", LlmModelConfig.builder().modelId("test").build());

        assertThat(result).isEqualTo("executed");
        verify(dangerAssessor, never()).assess(any(), any());
    }

    @Test
    void localMcpToolSkipsApprovalForFullLevel() {
        when(localToolExecutor.execute(7L, "mcp__filesystem__write_file", "{}", "workspace", false, null))
                .thenReturn("executed");

        String result = dispatcher.dispatch("mcp__filesystem__write_file", "{}", "LOCAL", 7L,
                "workspace", "FULL", null);

        assertThat(result).isEqualTo("executed");
    }

    @Test
    void cloudModeMcpToolExecutesViaSessionToolsWhenNotInGlobalRegistry() {
        // mcpTool 未注册进全局 ToolRegistry，仅存在于会话工具集；CLOUD 模式应能经 sessionTools 找到并执行
        when(mcpTool.execute("{}", 7L, 9L, "workspace")).thenReturn("cloud-mcp-result");

        String result = dispatcher.dispatch("mcp__filesystem__write_file", "{}", "CLOUD", 7L, 9L,
                "workspace", "READ_ONLY", null, List.of(mcpTool));

        assertThat(result).isEqualTo("cloud-mcp-result");
        verify(localToolExecutor, never()).execute(any(), any(), any(), any(), anyBoolean(), any());
    }

    @Test
    void cloudModeUnknownToolStillThrowsWhenNotInSessionTools() {
        // mcp__unregistered__tool 既不在全局 registry 也不在会话工具集 → Unknown tool
        assertThatThrownBy(() -> dispatcher.dispatch("mcp__unregistered__tool", "{}", "CLOUD", 7L, 9L,
                "workspace", "READ_ONLY", null, List.of(serverTool)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unknown tool");
    }

    private Tool mockTool(String name) {
        Tool tool = mock(Tool.class);
        when(tool.getName()).thenReturn(name);
        return tool;
    }
}
