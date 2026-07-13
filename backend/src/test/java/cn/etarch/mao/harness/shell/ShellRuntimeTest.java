package cn.etarch.mao.harness.shell;

import cn.etarch.mao.harness.core.BackgroundTaskManager;
import cn.etarch.mao.harness.runtime.RuntimeDataResolver;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.impl.ShellSessionTool;
import cn.etarch.mao.auth.service.JwtService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import cn.etarch.mao.user.service.GitCredentialService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.BufferedReader;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ShellRuntimeTest {

    @TempDir
    Path tempDir;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void outputManagerReadsUntilMarkerWritesFileAndFormatsResult() throws Exception {
        OutputManager outputManager = new OutputManager();
        ReflectionTestUtils.setField(outputManager, "maxPreviewLines", 2);
        ReflectionTestUtils.setField(outputManager, "maxPreviewChars", 20);
        Path outputFile = tempDir.resolve("out").resolve("cmd.out");

        OutputManager.OutputResult result = outputManager.readUntilMarker(
                new BufferedReader(new StringReader("one\ntwo\nthree\n__DONE__\nafter\n")),
                "__DONE__",
                Duration.ofSeconds(1),
                outputFile);

        assertThat(result.markerFound()).isTrue();
        assertThat(result.totalLines()).isEqualTo(3);
        assertThat(result.preview()).contains("two").contains("three").doesNotContain("one");
        assertThat(Files.readString(outputFile)).contains("one").contains("three");
        assertThat(outputManager.formatToolResult(0, "sh-1", 12, result, tempDir.toString()))
                .contains("exit_code: 0")
                .contains("session_id: sh-1")
                .contains("current_workdir");
    }

    @Test
    void outputManagerHandlesTimeoutAndReadErrors() {
        OutputManager outputManager = new OutputManager();
        ReflectionTestUtils.setField(outputManager, "maxPreviewLines", 100);
        ReflectionTestUtils.setField(outputManager, "maxPreviewChars", 1000);

        OutputManager.OutputResult timeout = outputManager.readUntilMarker(
                new BufferedReader(new StringReader("unterminated")),
                "__MISSING__",
                Duration.ofMillis(1),
                null);
        assertThat(timeout.markerFound()).isFalse();
        assertThat(timeout.truncated()).isTrue();

        BufferedReader broken = new BufferedReader(new StringReader("")) {
            @Override
            public boolean ready() throws java.io.IOException {
                throw new java.io.IOException("boom");
            }
        };
        assertThat(outputManager.readUntilMarker(broken, "x", Duration.ofSeconds(1), null).preview())
                .contains("Error reading output");
    }

    @Test
    void shellSessionManagerCreatesListsAndClosesRealShellSessions() throws Exception {
        ShellSessionManager manager = manager();

        ShellSession session = manager.getOrCreate(11L, "sh-test", 7L, tempDir.toString(), Map.of("git.example.com", "tok"));

        assertThat(session.getSessionId()).isEqualTo("sh-test");
        assertThat(session.isAlive()).isTrue();
        assertThat(session.getPid()).isGreaterThan(0);
        assertThat(session.nextOutputFile().getFileName().toString()).isEqualTo("sh-test_1.out");
        assertThat(manager.getSession("sh-test")).isSameAs(session);
        assertThat(manager.listByConversation(11L)).contains(session);
        assertThat(manager.getActiveSessionCount()).isEqualTo(1);
        assertThat(tempDir.resolve("runtime").resolve("7").resolve("11").resolve("git-askpass.sh")).exists();

        ShellSession same = manager.getOrCreate(11L, "sh-test", 7L, tempDir.toString(), Map.of());
        assertThat(same).isSameAs(session);
        manager.close("sh-test");
        assertThat(manager.getSession("sh-test")).isNull();
        assertThat(session.isAlive()).isFalse();
    }

    @Test
    void shellSessionManagerEnforcesLimitsAndCleanup() {
        ShellSessionManager manager = manager();
        ReflectionTestUtils.setField(manager, "maxSessionsPerConversation", 1);
        ShellSession first = manager.getOrCreate(12L, "one", 7L, tempDir.toString(), Map.of());

        assertThatThrownBy(() -> manager.getOrCreate(12L, "two", 7L, tempDir.toString(), Map.of()))
                .isInstanceOf(IllegalStateException.class);

        first.close();
        manager.cleanupExpiredSessions();
        assertThat(manager.getActiveSessionCount()).isZero();
        manager.closeByConversation(12L);
    }

    @Test
    void shellSessionSetsIsolatedHomeForUser() throws Exception {
        Path userHomeRoot = tempDir.resolve("users");
        PathSandbox pathSandbox = new PathSandbox(tempDir.toString());
        ShellSessionManager manager = new ShellSessionManager(
                pathSandbox,
                RuntimeDataResolver.forTest(tempDir.resolve("runtime").toString(), userHomeRoot.toString()));
        ReflectionTestUtils.setField(manager, "maxSessionsPerConversation", 30);
        ReflectionTestUtils.setField(manager, "sessionIdleTimeoutMinutes", 30);
        ReflectionTestUtils.setField(manager, "sessionMaxLifetimeHours", 2);

        OutputManager outputManager = new OutputManager();
        ReflectionTestUtils.setField(outputManager, "maxPreviewLines", 100);
        ReflectionTestUtils.setField(outputManager, "maxPreviewChars", 1000);
        GitCredentialService gitCredentialService = mock(GitCredentialService.class);
        when(gitCredentialService.getTokenMapByUser(7L)).thenReturn(Map.of());
        ShellSessionTool tool = new ShellSessionTool(
                objectMapper,
                pathSandbox,
                manager,
                outputManager,
                new BackgroundTaskManager(),
                gitCredentialService,
                mockJwtService(),
                mockUserMapper(7L, "tester"));

        Path expectedUserHome = userHomeRoot.resolve("7").toAbsolutePath().normalize();
        String exec = tool.execute("""
                {"command":"echo $HOME","session_id":"home-sh","yield_time_ms":2000}
                """, 31L, 7L, tempDir.toString());

        assertThat(exec).contains("exit_code: 0");
        assertThat(exec).contains(expectedUserHome.toString());
        assertThat(expectedUserHome).exists();

        Path tokenFile = expectedUserHome.resolve(".mao").resolve("sso_token.json");
        pathSandbox.resolve(tokenFile.toString());
    }

    @Test
    void shellSessionToolInjectsMaoTokenEnvOnEachExec() throws Exception {
        ShellSessionManager manager = manager();
        OutputManager outputManager = new OutputManager();
        ReflectionTestUtils.setField(outputManager, "maxPreviewLines", 100);
        ReflectionTestUtils.setField(outputManager, "maxPreviewChars", 1000);
        GitCredentialService gitCredentialService = mock(GitCredentialService.class);
        when(gitCredentialService.getTokenMapByUser(7L)).thenReturn(Map.of());
        ShellSessionTool tool = new ShellSessionTool(
                objectMapper,
                new PathSandbox(tempDir.toString()),
                manager,
                outputManager,
                new BackgroundTaskManager(),
                gitCredentialService,
                mockJwtService(),
                mockUserMapper(7L, "tester"));

        String exec = tool.execute("""
                {"command":"echo $MAO_TOKEN","session_id":"token-sh","yield_time_ms":2000}
                """, 41L, 7L, tempDir.toString());
        assertThat(exec).contains("exit_code: 0");
        assertThat(exec).contains("shell-token-for-tester");
    }

    @Test
    void shellSessionToolExecListWriteCloseAndAsyncPaths() throws Exception {
        ShellSessionManager manager = manager();
        OutputManager outputManager = new OutputManager();
        ReflectionTestUtils.setField(outputManager, "maxPreviewLines", 100);
        ReflectionTestUtils.setField(outputManager, "maxPreviewChars", 1000);
        GitCredentialService gitCredentialService = mock(GitCredentialService.class);
        when(gitCredentialService.getTokenMapByUser(7L)).thenReturn(Map.of());
        ShellSessionTool tool = new ShellSessionTool(
                objectMapper,
                new PathSandbox(tempDir.toString()),
                manager,
                outputManager,
                new BackgroundTaskManager(),
                gitCredentialService,
                mockJwtService(),
                mockUserMapper(7L, "tester"));

        assertThat(tool.getName()).isEqualTo("shell");
        assertThat(tool.getDescription()).contains("shell");
        assertThat(tool.getInputSchema()).containsKey("properties");
        assertThat(tool.getOutputSchema()).containsKey("properties");

        String exec = tool.execute("""
                {"command":"echo hello","session_id":"tool-sh","yield_time_ms":2000}
                """, 21L, 7L, tempDir.toString());
        assertThat(exec).contains("exit_code: 0").contains("hello");

        JsonNode list = objectMapper.readTree(tool.execute("{\"action\":\"list\"}", 21L, 7L, tempDir.toString()));
        assertThat(list.get("count").asInt()).isEqualTo(1);

        JsonNode stdin = objectMapper.readTree(tool.execute("""
                {"action":"write_stdin","session_id":"tool-sh","input":"echo stdin","yield_time_ms":2000}
                """, 21L, 7L, tempDir.toString()));
        assertThat(stdin.get("output").asText()).contains("stdin");

        JsonNode close = objectMapper.readTree(tool.execute("""
                {"action":"close","session_id":"tool-sh"}
                """, 21L, 7L, tempDir.toString()));
        assertThat(close.get("status").asText()).contains("关闭");

        JsonNode async = objectMapper.readTree(tool.execute("""
                {"command":"echo async","async":true}
                """, 21L, 7L, tempDir.toString()));
        assertThat(async.get("async").asBoolean()).isTrue();
        assertThat(async.get("task_id").asText()).isNotBlank();

        // 测试 keep_session 默认为 false 时自动关闭会话
        JsonNode keepFalse = objectMapper.readTree(tool.execute("""
                {"command":"echo keep_false","keep_session":false}
                """, 21L, 7L, tempDir.toString()));
        assertThat(keepFalse.get("exit_code").asInt()).isEqualTo(0);
        // 会话应该已关闭，list 应该返回 0
        JsonNode listAfterKeepFalse = objectMapper.readTree(tool.execute("{\"action\":\"list\"}", 21L, 7L, tempDir.toString()));
        assertThat(listAfterKeepFalse.get("count").asInt()).isEqualTo(0);

        // 测试 keep_session 为 true 时保留会话
        JsonNode keepTrue = objectMapper.readTree(tool.execute("""
                {"command":"echo keep_true","keep_session":true}
                """, 21L, 7L, tempDir.toString()));
        assertThat(keepTrue.get("exit_code").asInt()).isEqualTo(0);
        String keepTrueSessionId = keepTrue.get("session_id").asText();
        // 会话应该仍然存在
        JsonNode listAfterKeepTrue = objectMapper.readTree(tool.execute("{\"action\":\"list\"}", 21L, 7L, tempDir.toString()));
        assertThat(listAfterKeepTrue.get("count").asInt()).isEqualTo(1);
        // 手动关闭会话
        tool.execute("{\"action\":\"close\",\"session_id\":\"" + keepTrueSessionId + "\"}", 21L, 7L, tempDir.toString());
    }

    @Test
    void shellSessionToolReturnsJsonErrorsForInvalidRequests() throws Exception {
        ShellSessionTool tool = new ShellSessionTool(
                objectMapper,
                new PathSandbox(tempDir.toString()),
                manager(),
                new OutputManager(),
                new BackgroundTaskManager(),
                mock(GitCredentialService.class),
                mockJwtService(),
                mockUserMapper(7L, "tester"));

        assertThat(error(tool.execute("{\"action\":\"unknown\"}", 1L, 7L, tempDir.toString()))).contains("未知动作");
        assertThat(error(tool.execute("{\"action\":\"exec\"}", 1L, 7L, tempDir.toString()))).contains("command");
        assertThat(error(tool.execute("{\"action\":\"write_stdin\"}", 1L, 7L, tempDir.toString()))).contains("session_id");
        assertThat(error(tool.execute("{\"action\":\"close\"}", 1L, 7L, tempDir.toString()))).contains("session_id");
        assertThat(error(tool.execute("{\"action\":\"write_stdin\",\"session_id\":\"missing\",\"input\":\"x\"}", 1L, 7L, tempDir.toString()))).contains("会话不存在");
        assertThat(error(tool.execute("not json", 1L, 7L, tempDir.toString()))).contains("错误");
    }

    private String error(String json) throws Exception {
        return objectMapper.readTree(json).get("error").asText();
    }

    private ShellSessionManager manager() {
        ShellSessionManager manager = new ShellSessionManager(
                new PathSandbox(tempDir.toString()),
                RuntimeDataResolver.forTest(
                        tempDir.resolve("runtime").toString(),
                        tempDir.resolve("users").toString()));
        ReflectionTestUtils.setField(manager, "maxSessionsPerConversation", 30);
        ReflectionTestUtils.setField(manager, "sessionIdleTimeoutMinutes", 30);
        ReflectionTestUtils.setField(manager, "sessionMaxLifetimeHours", 2);
        return manager;
    }

    private JwtService mockJwtService() {
        JwtService jwtService = mock(JwtService.class);
        when(jwtService.generateShellToken(anyLong(), anyString()))
                .thenAnswer(inv -> "shell-token-for-" + inv.getArgument(1));
        return jwtService;
    }

    private UserMapper mockUserMapper(Long userId, String username) {
        UserMapper userMapper = mock(UserMapper.class);
        User user = new User();
        user.setId(userId);
        user.setUsername(username);
        when(userMapper.selectById(userId)).thenReturn(user);
        return userMapper;
    }
}
