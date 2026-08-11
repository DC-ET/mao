package cn.etarch.mao.file.service;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.runtime.RuntimeDataResolver;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.user.service.GitCredentialService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GitWriteOperationServiceTest {
    @TempDir Path tempDir;

    static boolean gitAvailable() { try { Process p = new ProcessBuilder("git", "--version").start(); return p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0; } catch (Exception e) { return false; } }

    @Test
    void askpassScriptIsValidAndReturnsConfiguredToken() throws Exception {
        Path script = tempDir.resolve("git-askpass.sh");
        Files.writeString(script, GitWriteOperationService.ASKPASS);
        run(tempDir, "bash", "-n", script.toString());

        ProcessBuilder usernameBuilder = new ProcessBuilder("bash", script.toString(), "Username for 'https://git.acg.team':");
        usernameBuilder.directory(tempDir.toFile());
        Process username = usernameBuilder.start();
        assertThat(new String(username.getInputStream().readAllBytes()).trim()).isEqualTo("oauth2");
        assertThat(username.waitFor(5, TimeUnit.SECONDS)).isTrue();
        assertThat(username.exitValue()).isZero();

        ProcessBuilder passwordBuilder = new ProcessBuilder("bash", script.toString(), "Password for 'https://oauth2@git.acg.team':");
        passwordBuilder.directory(tempDir.toFile());
        passwordBuilder.environment().putAll(Map.of("GIT_TOKEN_git_acg_team", "secret-token"));
        Process password = passwordBuilder.start();
        assertThat(new String(password.getInputStream().readAllBytes()).trim()).isEqualTo("secret-token");
        assertThat(password.waitFor(5, TimeUnit.SECONDS)).isTrue();
        assertThat(password.exitValue()).isZero();
    }

    @Test
    void sensitiveFileRulesCoverCredentialsAndKeys() {
        assertThat(GitWriteOperationService.isSensitive(".env.production")).isTrue();
        assertThat(GitWriteOperationService.isSensitive("cert/client.pem")).isTrue();
        assertThat(GitWriteOperationService.isSensitive("keys/id_ed25519.backup")).isTrue();
        assertThat(GitWriteOperationService.isSensitive("config/api-token.json")).isTrue();
        assertThat(GitWriteOperationService.isSensitive("src/tokenizer.java")).isTrue();
        assertThat(GitWriteOperationService.isSensitive("src/Main.java")).isFalse();
    }

    @Test
    @EnabledIf("gitAvailable")
    void commitInputFiltersSensitiveAndBinaryAndFairlyTruncates() throws Exception {
        Path repo = tempDir.resolve("repo"); Files.createDirectories(repo);
        run(repo, "git", "init"); run(repo, "git", "config", "user.name", "Test"); run(repo, "git", "config", "user.email", "a@b.c");
        Files.writeString(repo.resolve("base.txt"), "base\n"); run(repo, "git", "add", "."); run(repo, "git", "commit", "-m", "init");
        Files.writeString(repo.resolve("a.txt"), "a".repeat(150_000));
        Files.writeString(repo.resolve("b.txt"), "b".repeat(150_000));
        Files.writeString(repo.resolve(".env"), "SECRET=value");
        Files.write(repo.resolve("image.bin"), new byte[]{0, 1, 2});

        WorkspaceGitService workspace = new WorkspaceGitService(new PathSandbox(tempDir.resolve("sandbox").toString()));
        GitWriteOperationService service = new GitWriteOperationService(workspace, mock(GitCommitMessageService.class),
                mock(GitCredentialService.class), mock(RuntimeDataResolver.class), mock(ActivityService.class), new ObjectMapper());
        var input = service.buildCommitInput(repo, workspace.changedFiles(repo));

        assertThat(input.getFiles()).hasSize(4);
        assertThat(input.getDiffBytes()).isLessThanOrEqualTo(GitCommitMessageService.MAX_DIFF_BYTES);
        assertThat(input.isTruncated()).isTrue();
        assertThat(input.getFiles().stream().filter(f -> f.getPath().equals("a.txt")).findFirst().orElseThrow().getDiff()).isNotEmpty();
        assertThat(input.getFiles().stream().filter(f -> f.getPath().equals("b.txt")).findFirst().orElseThrow().getDiff()).isNotEmpty();
        assertThat(input.getFiles().stream().filter(f -> f.getPath().equals(".env")).findFirst().orElseThrow().getDiff()).isNull();
        assertThat(input.getFiles().stream().filter(f -> f.getPath().equals("image.bin")).findFirst().orElseThrow().getDiff()).isNull();
    }

    @Test
    @EnabledIf("gitAvailable")
    void renamedSensitivePathNeverIncludesDiff() throws Exception {
        Path repo = tempDir.resolve("renamed"); Files.createDirectories(repo);
        run(repo, "git", "init"); run(repo, "git", "config", "user.name", "Test"); run(repo, "git", "config", "user.email", "a@b.c");
        Files.writeString(repo.resolve(".env"), "SECRET=never-upload\n");
        run(repo, "git", "add", "."); run(repo, "git", "commit", "-m", "init");
        run(repo, "git", "mv", ".env", "config.txt");

        WorkspaceGitService workspace = new WorkspaceGitService(new PathSandbox(tempDir.resolve("rename-sandbox").toString()));
        GitWriteOperationService service = new GitWriteOperationService(workspace, mock(GitCommitMessageService.class),
                mock(GitCredentialService.class), mock(RuntimeDataResolver.class), mock(ActivityService.class), new ObjectMapper());
        var input = service.buildCommitInput(repo, workspace.changedFiles(repo));
        var renamed = input.getFiles().get(0);

        assertThat(renamed.getPath()).isEqualTo("config.txt");
        assertThat(renamed.isSensitive()).isTrue();
        assertThat(renamed.getDiff()).isNull();
    }

    @Test
    @EnabledIf("gitAvailable")
    void refreshFetchesSelectedRemoteAndReportsAheadBehind() throws Exception {
        Path remote = tempDir.resolve("remote.git");
        run(tempDir, "git", "init", "--bare", remote.toString());
        Path repo = tempDir.resolve("refresh-repo");
        Files.createDirectories(repo);
        run(repo, "git", "init");
        run(repo, "git", "config", "user.name", "Test");
        run(repo, "git", "config", "user.email", "a@b.c");
        Files.writeString(repo.resolve("base.txt"), "base\n");
        run(repo, "git", "add", ".");
        run(repo, "git", "commit", "-m", "init");
        String branch = capture(repo, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
        run(repo, "git", "remote", "add", "origin", remote.toString());
        run(repo, "git", "push", "-u", "origin", branch);

        Path other = tempDir.resolve("other");
        run(tempDir, "git", "clone", remote.toString(), other.toString());
        run(other, "git", "config", "user.name", "Other");
        run(other, "git", "config", "user.email", "other@example.com");
        Files.writeString(other.resolve("remote.txt"), "remote\n");
        run(other, "git", "add", ".");
        run(other, "git", "commit", "-m", "remote");
        run(other, "git", "push");

        GitWriteOperationService service = newService(repo);
        WorkspaceGitService.GitStatusDTO status = service.refreshRemoteStatus(session(repo), null);

        assertThat(status.isRemoteStatusAvailable()).isTrue();
        assertThat(status.getRemoteStatusError()).isNull();
        assertThat(status.getAheadCount()).isZero();
        assertThat(status.getBehindCount()).isEqualTo(1);
        assertThat(status.isHasHead()).isTrue();
    }

    @Test
    @EnabledIf("gitAvailable")
    void refreshPrefersUpstreamRemoteOverOrigin() throws Exception {
        Path upstream = tempDir.resolve("upstream.git");
        run(tempDir, "git", "init", "--bare", upstream.toString());
        Path repo = tempDir.resolve("upstream-refresh");
        Files.createDirectories(repo);
        run(repo, "git", "init");
        run(repo, "git", "config", "user.name", "Test");
        run(repo, "git", "config", "user.email", "a@b.c");
        Files.writeString(repo.resolve("base.txt"), "base\n");
        run(repo, "git", "add", ".");
        run(repo, "git", "commit", "-m", "init");
        String branch = capture(repo, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
        run(repo, "git", "remote", "add", "upstream", upstream.toString());
        run(repo, "git", "push", "-u", "upstream", branch);
        run(repo, "git", "remote", "add", "origin", "https://invalid:secret@example.invalid/repo.git");

        WorkspaceGitService.GitStatusDTO status = newService(repo).refreshRemoteStatus(session(repo), null);

        assertThat(status.isRemoteStatusAvailable()).isTrue();
        assertThat(status.getRemoteStatusError()).isNull();
    }

    @Test
    @EnabledIf("gitAvailable")
    void refreshFailureReturnsLocalStatusAndSanitizedError() throws Exception {
        Path repo = tempDir.resolve("failed-refresh");
        Files.createDirectories(repo);
        run(repo, "git", "init");
        run(repo, "git", "config", "user.name", "Test");
        run(repo, "git", "config", "user.email", "a@b.c");
        Files.writeString(repo.resolve("base.txt"), "base\n");
        run(repo, "git", "add", ".");
        run(repo, "git", "commit", "-m", "init");
        run(repo, "git", "remote", "add", "origin", "https://user:secret@example.invalid/repo.git");

        WorkspaceGitService.GitStatusDTO status = newService(repo).refreshRemoteStatus(session(repo), null);

        assertThat(status.getIsGit()).isTrue();
        assertThat(status.isRemoteStatusAvailable()).isFalse();
        assertThat(status.getRemoteStatusError()).isNotBlank().doesNotContain("user:secret");
    }

    @Test
    @EnabledIf("gitAvailable")
    void multipleRemotesWithoutOriginCannotBeConfirmed() throws Exception {
        Path repo = tempDir.resolve("multi-remote");
        Files.createDirectories(repo);
        run(repo, "git", "init");
        run(repo, "git", "config", "user.name", "Test");
        run(repo, "git", "config", "user.email", "a@b.c");
        Files.writeString(repo.resolve("base.txt"), "base\n");
        run(repo, "git", "add", ".");
        run(repo, "git", "commit", "-m", "init");
        run(repo, "git", "remote", "add", "alpha", tempDir.resolve("alpha.git").toString());
        run(repo, "git", "remote", "add", "beta", tempDir.resolve("beta.git").toString());

        WorkspaceGitService.GitStatusDTO status = newService(repo).refreshRemoteStatus(session(repo), null);

        assertThat(status.isRemoteStatusAvailable()).isFalse();
        assertThat(status.getRemoteStatusError()).contains("多个远端");
    }

    private GitWriteOperationService newService(Path repo) {
        WorkspaceGitService workspace = new WorkspaceGitService(new PathSandbox(tempDir.resolve("refresh-sandbox").toString()));
        GitCredentialService credentials = mock(GitCredentialService.class);
        when(credentials.getTokenMapByUser(1L)).thenReturn(Map.of());
        return new GitWriteOperationService(workspace, mock(GitCommitMessageService.class), credentials,
                mock(RuntimeDataResolver.class), mock(ActivityService.class), new ObjectMapper());
    }

    private static Session session(Path repo) {
        Session session = new Session();
        session.setId(1L);
        session.setUserId(1L);
        session.setWorkspace(repo.toString());
        return session;
    }

    private static String capture(Path cwd, String... command) throws Exception {
        Process p = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        if (!p.waitFor(30, TimeUnit.SECONDS) || p.exitValue() != 0) throw new IllegalStateException(out);
        return out;
    }

    private static void run(Path cwd, String... command) throws Exception {
        Process p = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        if (!p.waitFor(30, TimeUnit.SECONDS) || p.exitValue() != 0) throw new IllegalStateException(out);
    }
}
