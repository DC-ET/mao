package cn.etarch.mao.harness.safety;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PathSandboxTest {

    @TempDir
    Path tempDir;

    @Test
    void resolvesRelativePathsUnderDefaultWorkspace() {
        PathSandbox sandbox = new PathSandbox(tempDir.toString());

        assertThat(sandbox.resolve("src/../README.md"))
                .isEqualTo(tempDir.resolve("README.md").toAbsolutePath().normalize());
        assertThat(sandbox.resolveAsFile("README.md").toPath())
                .isEqualTo(tempDir.resolve("README.md").toAbsolutePath().normalize());
        assertThat(sandbox.getWorkspaceRoot())
                .isEqualTo(tempDir.toAbsolutePath().normalize());
    }

    @Test
    void resolvesRelativePathsUnderSessionWorkspace() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/1"));
        PathSandbox sandbox = new PathSandbox(tempDir.resolve("default").toString());

        assertThat(sandbox.resolve("notes.txt", sessionWorkspace.toString()))
                .isEqualTo(sessionWorkspace.resolve("notes.txt").toAbsolutePath().normalize());
        assertThat(sandbox.getEffectiveWorkspaceRoot(sessionWorkspace.toString()))
                .isEqualTo(sessionWorkspace.toAbsolutePath().normalize());
    }

    @Test
    void rejectsEmptyTildeAndEscapingPaths() {
        PathSandbox sandbox = new PathSandbox(tempDir.toString());

        assertThatThrownBy(() -> sandbox.resolve(""))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> sandbox.resolve("~/secret"))
                .isInstanceOf(SecurityException.class);
        assertThatThrownBy(() -> sandbox.resolve("../secret"))
                .isInstanceOf(SecurityException.class);
        assertThatThrownBy(() -> sandbox.resolve(tempDir.getParent().resolve("secret").toString()))
                .isInstanceOf(SecurityException.class);
    }

    @Test
    void allowsRegisteredAbsoluteRoots() throws Exception {
        Path allowed = Files.createDirectories(tempDir.resolveSibling(tempDir.getFileName() + "-allowed"));
        Path file = Files.writeString(allowed.resolve("skill.md"), "content");
        PathSandbox sandbox = new PathSandbox(tempDir.toString());

        sandbox.addAllowedRoot(allowed);

        assertThat(sandbox.resolve(file.toString())).isEqualTo(file.toAbsolutePath().normalize());
    }
}
