package cn.etarch.mao.harness.core;

import cn.etarch.mao.session.entity.Session;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class EnvironmentInfoProviderTest {

    private final EnvironmentInfoProvider provider = new EnvironmentInfoProvider();

    @TempDir
    Path tempDir;

    @Test
    void detectReportsGitWorkspaceAndRuntimeDefaults() throws Exception {
        Path project = Files.createDirectories(tempDir.resolve("repo/subdir"));
        Files.createDirectories(tempDir.resolve("repo/.git"));

        EnvironmentInfoProvider.EnvironmentInfo info = provider.detect(project.toString());

        assertThat(info.isGit()).isTrue();
        assertThat(info.platform()).isIn("darwin", "linux", "win32");
        assertThat(info.shell()).isNotBlank();
        assertThat(info.osVersion()).isNotBlank();
    }

    @Test
    void detectReturnsFalseWhenWorkspaceIsBlankOrNotGit() {
        assertThat(provider.detect(null).isGit()).isFalse();
        assertThat(provider.detect(tempDir.toString()).isGit()).isFalse();
    }

    @Test
    void fromSessionUsesLocalEnvironmentSnapshotForLocalMode() {
        Session session = new Session();
        session.setExecutionMode("LOCAL");
        session.setIsGit(true);
        session.setPlatform("darwin");
        session.setShellPath("/bin/zsh");
        session.setOsVersion("Darwin 25.0");

        EnvironmentInfoProvider.EnvironmentInfo info = provider.fromSessionOrDetect(session);

        assertThat(info.isGit()).isTrue();
        assertThat(info.platform()).isEqualTo("darwin");
        assertThat(info.shell()).isEqualTo("/bin/zsh");
        assertThat(info.osVersion()).isEqualTo("Darwin 25.0");
    }

    @Test
    void fromSessionMergesCloudSessionOverridesWithDetectedValues() throws Exception {
        Path project = Files.createDirectories(tempDir.resolve("repo"));
        Files.createDirectories(project.resolve(".git"));
        Session session = new Session();
        session.setExecutionMode("CLOUD");
        session.setWorkspace(project.toString());
        session.setIsGit(false);
        session.setPlatform("custom-platform");
        session.setShellPath("custom-shell");
        session.setOsVersion("custom-os");

        EnvironmentInfoProvider.EnvironmentInfo info = provider.fromSessionOrDetect(session);

        assertThat(info.isGit()).isFalse();
        assertThat(info.platform()).isEqualTo("custom-platform");
        assertThat(info.shell()).isEqualTo("custom-shell");
        assertThat(info.osVersion()).isEqualTo("custom-os");
    }
}
