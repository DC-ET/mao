package com.agentworkbench.session.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Path;
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

    /**
     * Clone a git repository to the target directory.
     *
     * @param url       git repository URL (HTTPS or SSH)
     * @param branch    branch name (optional, uses default if null/blank)
     * @param targetDir destination directory (must exist)
     * @return clone result with success flag and error message
     */
    public GitCloneResult clone(String url, String branch, Path targetDir) {
        List<String> command = new ArrayList<>();
        command.add("git");
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
                // Extract last few lines as a user-friendly error
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
