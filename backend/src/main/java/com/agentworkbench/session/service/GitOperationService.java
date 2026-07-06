package com.agentworkbench.session.service;

import com.agentworkbench.session.util.GitUrlParser;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Executes git clone operations for workspace initialization.
 * Supports both HTTPS and SSH protocols. SSH keys are assumed to be
 * pre-configured on the server by operations.
 */
@Slf4j
@Service
public class GitOperationService {

    /** Maximum time allowed for a single git clone operation. */
    private static final long CLONE_TIMEOUT_SECONDS = 120;

    private static final long KEYSCAN_TIMEOUT_SECONDS = 30;

    /**
     * Non-interactive SSH options passed via git -c core.sshCommand (more reliable than GIT_SSH_COMMAND).
     */
    private static final String CORE_SSH_COMMAND =
            "ssh -o StrictHostKeyChecking=yes -o BatchMode=yes";

    /**
     * Clone a git repository to the target directory.
     *
     * @param url       git repository URL (HTTPS or SSH)
     * @param branch    branch name (optional, uses default if null/blank)
     * @param targetDir destination directory (must exist)
     * @return clone result with success flag and error message
     */
    public GitCloneResult clone(String url, String branch, Path targetDir) {
        if (url.startsWith("git@")) {
            GitCloneResult hostKeyResult = ensureHostKeyKnown(GitUrlParser.extractHost(url));
            if (!hostKeyResult.success()) {
                return hostKeyResult;
            }
        }

        List<String> command = new ArrayList<>();
        command.add("git");
        if (url.startsWith("git@")) {
            command.add("-c");
            command.add("core.sshCommand=" + CORE_SSH_COMMAND);
        }
        command.add("clone");
        command.add("--depth");
        command.add("1");
        if (branch != null && !branch.isBlank()) {
            command.add("--branch");
            command.add(branch);
        }
        command.add(url);
        command.add(targetDir.toString());

        log.info("Starting git clone: {} → {} (branch: {})", url, targetDir,
                branch != null && !branch.isBlank() ? branch : "default");

        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);
            process = pb.start();
            process.getOutputStream().close();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                    log.debug("git clone [{}]: {}", url, line);
                }
            }

            boolean finished = process.waitFor(CLONE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                log.warn("Git clone timeout for {} after {}s", url, CLONE_TIMEOUT_SECONDS);
                return GitCloneResult.failed("Git clone timeout (>" + CLONE_TIMEOUT_SECONDS + "s)");
            }

            int exitCode = process.exitValue();
            if (exitCode == 0) {
                log.info("Git clone succeeded: {} → {}", url, targetDir);
                return GitCloneResult.ok();
            } else {
                String tail = extractTail(output.toString(), 500);
                log.warn("Git clone failed for {}: exit={}, output={}", url, exitCode, tail);
                return GitCloneResult.failed("Git clone failed: " + tail);
            }
        } catch (IOException e) {
            log.error("Git clone IO error for {}: {}", url, e.getMessage());
            return GitCloneResult.failed("Git clone error: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (process != null) {
                process.destroyForcibly();
            }
            return GitCloneResult.failed("Git clone interrupted");
        }
    }

    /**
     * Pre-populate ~/.ssh/known_hosts via ssh-keyscan so git clone never blocks on host verification.
     */
    private GitCloneResult ensureHostKeyKnown(String host) {
        try {
            if (isHostKnown(host)) {
                log.debug("SSH host already known: {}", host);
                return GitCloneResult.ok();
            }

            log.info("Fetching SSH host key via ssh-keyscan: {}", host);
            ProcessBuilder pb = new ProcessBuilder("ssh-keyscan", "-H", host);
            pb.redirectErrorStream(true);
            Process process = pb.start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.startsWith("#")) {
                        output.append(line).append('\n');
                    }
                }
            }

            boolean finished = process.waitFor(KEYSCAN_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return GitCloneResult.failed("ssh-keyscan timeout for " + host);
            }
            if (process.exitValue() != 0 || output.isEmpty()) {
                return GitCloneResult.failed("ssh-keyscan failed for " + host
                        + " (exit=" + process.exitValue() + ")");
            }

            Path sshDir = Paths.get(System.getProperty("user.home"), ".ssh");
            Files.createDirectories(sshDir);
            Path knownHosts = sshDir.resolve("known_hosts");
            Files.writeString(knownHosts, output.toString(),
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            log.info("Added SSH host key for {} to {}", host, knownHosts);
            return GitCloneResult.ok();
        } catch (IOException e) {
            log.error("ssh-keyscan IO error for {}: {}", host, e.getMessage());
            return GitCloneResult.failed("ssh-keyscan error: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return GitCloneResult.failed("ssh-keyscan interrupted");
        }
    }

    private boolean isHostKnown(String host) throws IOException, InterruptedException {
        Process process = new ProcessBuilder("ssh-keygen", "-F", host).start();
        boolean finished = process.waitFor(10, TimeUnit.SECONDS);
        return finished && process.exitValue() == 0;
    }

    private String extractTail(String output, int maxLen) {
        if (output == null || output.isBlank()) return "";
        String trimmed = output.trim();
        if (trimmed.length() <= maxLen) return trimmed;
        return "..." + trimmed.substring(trimmed.length() - maxLen);
    }

    public record GitCloneResult(boolean success, String error) {
        public static GitCloneResult ok() {
            return new GitCloneResult(true, null);
        }

        public static GitCloneResult failed(String error) {
            return new GitCloneResult(false, error);
        }
    }
}
