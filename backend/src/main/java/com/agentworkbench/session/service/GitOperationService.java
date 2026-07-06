package com.agentworkbench.session.service;

import com.agentworkbench.session.util.GitCloneErrorFormatter;
import com.agentworkbench.session.util.GitUrlParser;
import com.agentworkbench.user.service.GitCredentialService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Executes git clone operations for workspace initialization (HTTPS only).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GitOperationService {

    /** Maximum time allowed for a single git clone operation. */
    private static final long CLONE_TIMEOUT_SECONDS = 120;

    private final GitCredentialService gitCredentialService;

    /**
     * Clone a git repository to the target directory.
     *
     * @param url       HTTPS git repository URL
     * @param branch    branch name (optional, uses default if null/blank)
     * @param targetDir destination directory (must exist)
     * @param userId    current user ID for per-user HTTPS token injection (nullable)
     * @return clone result with success flag and error message
     */
    public GitCloneResult clone(String url, String branch, Path targetDir, Long userId) {
        GitUrlParser.validate(url);
        String effectiveUrl = userId != null ? injectUserToken(url, userId) : url;

        List<String> command = new ArrayList<>();
        command.add("git");
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
