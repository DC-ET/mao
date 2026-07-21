package cn.etarch.mao.file.service;

import cn.etarch.mao.harness.safety.PathSandbox;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceGitServiceTest {

    @TempDir
    Path tempDir;

    private WorkspaceGitService service;
    private Path repo;

    static boolean gitAvailable() {
        try {
            Process p = new ProcessBuilder("git", "--version").redirectErrorStream(true).start();
            boolean finished = p.waitFor(5, TimeUnit.SECONDS);
            return finished && p.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        service = new WorkspaceGitService(new PathSandbox(tempDir.resolve("sandbox-root").toString()));
        repo = tempDir.resolve("repo");
        Files.createDirectories(repo);
        run(repo, "git", "init");
        run(repo, "git", "config", "user.email", "test@example.com");
        run(repo, "git", "config", "user.name", "Test");
        Files.writeString(repo.resolve("README.md"), "hello\n");
        run(repo, "git", "add", "README.md");
        run(repo, "git", "commit", "-m", "init");
        // Ensure we're on a named branch (git init may use master or main)
        String branch = runCapture(repo, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
        if ("HEAD".equals(branch)) {
            run(repo, "git", "checkout", "-b", "main");
        }
    }

    @Test
    @EnabledIf("gitAvailable")
    void cleanRepoReportsZeroChanges() {
        WorkspaceGitService.GitStatusDTO status = service.getStatus(repo.toString());
        assertThat(status.getIsGit()).isTrue();
        assertThat(status.getBranch()).isNotBlank();
        assertThat(status.getChangedFileCount()).isZero();
        assertThat(status.getInsertions()).isZero();
        assertThat(status.getDeletions()).isZero();
        assertThat(status.getFiles()).isEmpty();
    }

    @Test
    @EnabledIf("gitAvailable")
    void modifiedUntrackedAndDeletedAreListed() throws Exception {
        Files.writeString(repo.resolve("README.md"), "hello\nworld\n");
        Files.writeString(repo.resolve("new.txt"), "line1\nline2\n");
        Files.writeString(repo.resolve("gone.txt"), "x\n");
        run(repo, "git", "add", "gone.txt");
        run(repo, "git", "commit", "-m", "add gone");
        Files.delete(repo.resolve("gone.txt"));

        WorkspaceGitService.GitStatusDTO status = service.getStatus(repo.toString());
        assertThat(status.getIsGit()).isTrue();
        assertThat(status.getChangedFileCount()).isEqualTo(3);
        assertThat(status.getFiles()).extracting(WorkspaceGitService.GitChangedFileDTO::getPath)
                .containsExactlyInAnyOrder("README.md", "new.txt", "gone.txt");

        WorkspaceGitService.GitChangedFileDTO readme = status.getFiles().stream()
                .filter(f -> "README.md".equals(f.getPath())).findFirst().orElseThrow();
        assertThat(readme.getChangeType()).isEqualTo("MODIFIED");
        assertThat(readme.getInsertions()).isGreaterThan(0);

        WorkspaceGitService.GitChangedFileDTO created = status.getFiles().stream()
                .filter(f -> "new.txt".equals(f.getPath())).findFirst().orElseThrow();
        assertThat(created.getChangeType()).isEqualTo("CREATED");
        assertThat(created.getUntracked()).isTrue();
        assertThat(created.getInsertions()).isEqualTo(2);

        WorkspaceGitService.GitChangedFileDTO deleted = status.getFiles().stream()
                .filter(f -> "gone.txt".equals(f.getPath())).findFirst().orElseThrow();
        assertThat(deleted.getChangeType()).isEqualTo("DELETED");

        WorkspaceGitService.GitFileDiffDTO diff = service.getFileDiff(repo.toString(), "README.md");
        assertThat(diff.getBeforeContent()).contains("hello");
        assertThat(diff.getAfterContent()).contains("world");
        assertThat(diff.getChangeType()).isEqualTo("MODIFIED");

        WorkspaceGitService.GitFileDiffDTO newDiff = service.getFileDiff(repo.toString(), "new.txt");
        assertThat(newDiff.getBeforeContent()).isEmpty();
        assertThat(newDiff.getAfterContent()).contains("line1");
    }

    @Test
    @EnabledIf("gitAvailable")
    void nonGitDirectoryReturnsIsGitFalse() throws IOException {
        Path plain = tempDir.resolve("plain");
        Files.createDirectories(plain);
        Files.writeString(plain.resolve("a.txt"), "a");
        WorkspaceGitService.GitStatusDTO status = service.getStatus(plain.toString());
        assertThat(status.getIsGit()).isFalse();
    }

    private static void run(Path cwd, String... command) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(cwd.toFile());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes());
        boolean finished = p.waitFor(30, TimeUnit.SECONDS);
        if (!finished || p.exitValue() != 0) {
            throw new IllegalStateException("Command failed: " + String.join(" ", command) + "\n" + out);
        }
    }

    private static String runCapture(Path cwd, String... command) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(cwd.toFile());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes());
        boolean finished = p.waitFor(30, TimeUnit.SECONDS);
        if (!finished || p.exitValue() != 0) {
            throw new IllegalStateException("Command failed: " + String.join(" ", command) + "\n" + out);
        }
        return out;
    }
}
