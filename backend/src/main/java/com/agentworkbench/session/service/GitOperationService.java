package com.agentworkbench.session.service;

import com.agentworkbench.session.util.GitUrlParser;
import com.agentworkbench.session.util.GitCloneErrorFormatter;
import com.agentworkbench.user.service.GitCredentialService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Executes git clone operations for workspace initialization.
 * Supports both HTTPS and SSH protocols. SSH keys are assumed to be
 * pre-configured on the server by operations.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GitOperationService {

    /** Maximum time allowed for a single git clone operation. */
    private static final long CLONE_TIMEOUT_SECONDS = 120;

    private static final long KEYSCAN_TIMEOUT_SECONDS = 30;

    /**
     * Non-interactive SSH options passed via git -c core.sshCommand (more reliable than GIT_SSH_COMMAND).
     */
    private static final String CORE_SSH_COMMAND =
            "ssh -o StrictHostKeyChecking=yes -o BatchMode=yes";

    private final GitCredentialService gitCredentialService;

    /**
     * Clone a git repository to the target directory.
     *
     * @param url       git repository URL (HTTPS or SSH)
     * @param branch    branch name (optional, uses default if null/blank)
     * @param targetDir destination directory (must exist)
     * @param userId    current user ID for per-user HTTPS token injection (nullable)
     * @return clone result with success flag and error message
     */
    public GitCloneResult clone(String url, String branch, Path targetDir, Long userId) {
        String effectiveUrl = url;
        if (url.startsWith("git@")) {
            GitCloneResult hostKeyResult = ensureHostKeyKnown(GitUrlParser.extractHost(url));
            if (!hostKeyResult.success()) {
                return hostKeyResult;
            }
        } else if (url.startsWith("https://") && userId != null) {
            effectiveUrl = injectUserToken(url, userId);
        }

        List<String> command = new ArrayList<>();
        command.add("git");
        if (effectiveUrl.startsWith("git@")) {
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
        command.add(effectiveUrl);
        command.add(targetDir.toString());

        log.info("Starting git clone: {} → {} (branch: {})",
                maskToken(effectiveUrl), targetDir,
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
                    log.debug("git clone [{}]: {}", maskToken(effectiveUrl), line);
                }
            }

            boolean finished = process.waitFor(CLONE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                log.warn("Git clone timeout for {} after {}s", maskToken(effectiveUrl), CLONE_TIMEOUT_SECONDS);
                return GitCloneResult.failed(GitCloneErrorFormatter.toUserMessage(
                        "Git clone timeout (>" + CLONE_TIMEOUT_SECONDS + "s)"));
            }

            int exitCode = process.exitValue();
            if (exitCode == 0) {
                log.info("Git clone succeeded: {} → {}", maskToken(effectiveUrl), targetDir);
                return GitCloneResult.ok();
            } else {
                String tail = extractTail(output.toString(), 500);
                log.warn("Git clone failed for {}: exit={}, output={}", maskToken(effectiveUrl), exitCode, tail);
                return GitCloneResult.failed(GitCloneErrorFormatter.toUserMessage(
                        "Git clone failed: " + tail));
            }
        } catch (IOException e) {
            log.error("Git clone IO error for {}: {}", maskToken(effectiveUrl), e.getMessage());
            return GitCloneResult.failed(GitCloneErrorFormatter.toUserMessage(
                    "Git clone error: " + e.getMessage()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (process != null) {
                process.destroyForcibly();
            }
            return GitCloneResult.failed(GitCloneErrorFormatter.toUserMessage("Git clone interrupted"));
        }
    }

    private String injectUserToken(String url, Long userId) {
        Map<String, String> tokenMap = gitCredentialService.getTokenMapByUser(userId);
        if (tokenMap.isEmpty()) {
            return url;
        }
        String host = GitUrlParser.extractHost(url);
        String token = tokenMap.get(host);
        if (token == null || token.isBlank()) {
            return url;
        }
        return injectHttpsToken(url, token);
    }

    static String injectHttpsToken(String url, String token) {
        if (!url.startsWith("https://")) {
            return url;
        }
        String remainder = url.substring("https://".length());
        int slashIdx = remainder.indexOf('/');
        int atIdx = remainder.indexOf('@');
        if (atIdx >= 0 && (slashIdx < 0 || atIdx < slashIdx)) {
            return url;
        }
        String encodedToken = URLEncoder.encode(token, StandardCharsets.UTF_8)
                .replace("+", "%20");
        return "https://oauth2:" + encodedToken + "@" + remainder;
    }

    static String maskToken(String url) {
        if (url == null) {
            return "";
        }
        return url.replaceAll("https://oauth2:[^@]+@", "https://oauth2:***@");
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
