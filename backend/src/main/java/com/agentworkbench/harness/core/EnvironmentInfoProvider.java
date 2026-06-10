package com.agentworkbench.harness.core;

import com.agentworkbench.session.entity.Session;
import lombok.Builder;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Collects execution environment details for prompt context.
 */
@Component
public class EnvironmentInfoProvider {

    public EnvironmentInfo detect(String workspace) {
        return EnvironmentInfo.builder()
                .isGit(isGitWorkspace(workspace))
                .platform(normalizePlatform(System.getProperty("os.name")))
                .shell(resolveShell())
                .osVersion(buildOsVersion())
                .build();
    }

    public EnvironmentInfo fromSessionOrDetect(Session session) {
        if ("LOCAL".equalsIgnoreCase(session.getExecutionMode())) {
            return EnvironmentInfo.builder()
                    .isGit(session.getIsGit())
                    .platform(session.getPlatform())
                    .shell(session.getShellPath())
                    .osVersion(session.getOsVersion())
                    .build();
        }

        EnvironmentInfo detected = detect(session.getWorkspace());
        return EnvironmentInfo.builder()
                .isGit(session.getIsGit() != null ? session.getIsGit() : detected.isGit())
                .platform(hasText(session.getPlatform()) ? session.getPlatform() : detected.platform())
                .shell(hasText(session.getShellPath()) ? session.getShellPath() : detected.shell())
                .osVersion(hasText(session.getOsVersion()) ? session.getOsVersion() : detected.osVersion())
                .build();
    }

    private boolean isGitWorkspace(String workspace) {
        if (!hasText(workspace)) return false;
        Path current = Path.of(workspace).toAbsolutePath().normalize();
        while (current != null) {
            if (Files.exists(current.resolve(".git"))) {
                return true;
            }
            current = current.getParent();
        }
        return false;
    }

    private String normalizePlatform(String osName) {
        String normalized = osName != null ? osName.toLowerCase(Locale.ROOT) : "";
        if (normalized.contains("mac") || normalized.contains("darwin")) return "darwin";
        if (normalized.contains("win")) return "win32";
        return "linux";
    }

    private String resolveShell() {
        String comspec = System.getenv("COMSPEC");
        if (hasText(comspec)) return comspec;
        return "win32".equals(normalizePlatform(System.getProperty("os.name"))) ? "cmd.exe" : "bash";
    }

    private String buildOsVersion() {
        String platform = normalizePlatform(System.getProperty("os.name"));
        String osName = System.getProperty("os.name", "");
        String osVersion = System.getProperty("os.version", "");
        if ("darwin".equals(platform) || "linux".equals(platform)) {
            String uname = readUnameSr();
            if (hasText(uname)) return uname;
        }
        if ("darwin".equals(platform)) {
            return "Darwin " + osVersion;
        }
        if ("linux".equals(platform)) {
            return "Linux " + osVersion;
        }
        return osName + " " + osVersion;
    }

    private String readUnameSr() {
        try {
            Process process = new ProcessBuilder("uname", "-sr")
                    .redirectErrorStream(true)
                    .start();
            if (!process.waitFor(2, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return null;
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                return reader.readLine();
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    @Builder
    public record EnvironmentInfo(Boolean isGit, String platform, String shell, String osVersion) {}
}
