package cn.etarch.mao.harness.shell;

import cn.etarch.mao.harness.runtime.RuntimeDataResolver;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.user.service.GitCredentialService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Shell 会话管理器，负责会话的创建、获取、关闭和清理
 */
@Slf4j
@Component
public class ShellSessionManager {

    private final PathSandbox pathSandbox;
    private final RuntimeDataResolver runtimeDataResolver;

    @Value("${app.harness.shell.max-sessions-per-conversation:30}")
    private int maxSessionsPerConversation;

    @Value("${app.harness.shell.session-idle-timeout-minutes:30}")
    private int sessionIdleTimeoutMinutes;

    @Value("${app.harness.shell.session-max-lifetime-hours:2}")
    private int sessionMaxLifetimeHours;

    private final ConcurrentHashMap<String, ShellSession> sessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, Set<String>> conversationSessions = new ConcurrentHashMap<>();

    public ShellSessionManager(PathSandbox pathSandbox, RuntimeDataResolver runtimeDataResolver) {
        this.pathSandbox = pathSandbox;
        this.runtimeDataResolver = runtimeDataResolver;
    }

    /**
     * 获取或创建会话
     *
     * @param conversationId   对话 ID（Mao session.id）
     * @param shellSessionId   Shell 会话 ID（可选，为空则自动生成）
     * @param userId           用户 ID，用于定位 runtime 目录
     * @param workspace        工作空间路径（命令 cwd）
     * @param domainTokenMap   用户 Git 域名→Token 映射（仅新建会话时使用）
     */
    public ShellSession getOrCreate(Long conversationId, String shellSessionId, Long userId,
                                    String workspace, Map<String, String> domainTokenMap) {
        if (shellSessionId != null && sessions.containsKey(shellSessionId)) {
            ShellSession session = sessions.get(shellSessionId);
            if (session.isAlive()) {
                session.touch();
                return session;
            }
            removeSession(shellSessionId);
        }

        Set<String> convSessions = conversationSessions.computeIfAbsent(conversationId, k -> ConcurrentHashMap.newKeySet());
        if (convSessions.size() >= maxSessionsPerConversation) {
            throw new IllegalStateException("Maximum number of shell sessions (" + maxSessionsPerConversation +
                    ") reached for conversation " + conversationId + ". Close existing sessions first.");
        }

        if (shellSessionId == null) {
            shellSessionId = "sh-" + conversationId + "-" + System.currentTimeMillis();
        }

        ShellSession session = createSession(shellSessionId, conversationId, userId, workspace, domainTokenMap);

        sessions.put(shellSessionId, session);
        convSessions.add(shellSessionId);

        log.info("Created shell session: {} for conversation: {}", shellSessionId, conversationId);
        return session;
    }

    public ShellSession getSession(String sessionId) {
        ShellSession session = sessions.get(sessionId);
        if (session == null || !session.isAlive()) {
            return null;
        }
        session.touch();
        return session;
    }

    public void close(String sessionId) {
        removeSession(sessionId);
    }

    public void closeByConversation(Long conversationId) {
        Set<String> convSessions = conversationSessions.remove(conversationId);
        if (convSessions != null) {
            for (String sessionId : convSessions) {
                ShellSession session = sessions.remove(sessionId);
                if (session != null) {
                    session.close();
                }
            }
            log.info("Closed {} shell sessions for conversation: {}", convSessions.size(), conversationId);
        }
    }

    public List<ShellSession> listByConversation(Long conversationId) {
        Set<String> convSessions = conversationSessions.get(conversationId);
        if (convSessions == null) {
            return Collections.emptyList();
        }

        List<ShellSession> result = new ArrayList<>();
        for (String sessionId : convSessions) {
            ShellSession session = sessions.get(sessionId);
            if (session != null && session.isAlive()) {
                result.add(session);
            }
        }
        return result;
    }

    @Scheduled(fixedRate = 60000)
    public void cleanupExpiredSessions() {
        Duration idleTimeout = Duration.ofMinutes(sessionIdleTimeoutMinutes);
        Duration maxLifetime = Duration.ofHours(sessionMaxLifetimeHours);

        int cleaned = 0;
        Iterator<Map.Entry<String, ShellSession>> iterator = sessions.entrySet().iterator();

        while (iterator.hasNext()) {
            Map.Entry<String, ShellSession> entry = iterator.next();
            ShellSession session = entry.getValue();

            if (!session.isAlive() || session.isIdleTimeout(idleTimeout) || session.isExpired(maxLifetime)) {
                String sessionId = entry.getKey();
                iterator.remove();
                removeSession(sessionId);
                cleaned++;
                log.info("Cleaned up expired shell session: {}", sessionId);
            }
        }

        if (cleaned > 0) {
            log.info("Cleaned up {} expired shell sessions", cleaned);
        }
    }

    public int getActiveSessionCount() {
        return sessions.size();
    }

    private ShellSession createSession(String shellSessionId, Long conversationId, Long userId,
                                       String workspace, Map<String, String> domainTokenMap) {
        try {
            Path workDir = pathSandbox.getEffectiveWorkspaceRoot(workspace);

            Path outputDir = runtimeDataResolver.resolveShellOutputDir(userId, conversationId);
            Files.createDirectories(outputDir);
            pathSandbox.addAllowedRoot(runtimeDataResolver.resolveSessionRuntimeDir(userId, conversationId));

            Path outputFile = outputDir.resolve(shellSessionId + ".out");

            ProcessBuilder pb = new ProcessBuilder();
            pb.command("bash", "--norc", "--noprofile");
            pb.directory(workDir.toFile());
            pb.redirectErrorStream(true);

            Map<String, String> env = pb.environment();
            env.put("TERM", "dumb");
            env.put("PS1", "");

            configureUserHome(env, userId);

            if (domainTokenMap != null && !domainTokenMap.isEmpty()) {
                configureGitCredentials(env, userId, conversationId, domainTokenMap);
            }

            Process process = pb.start();

            return new ShellSession(shellSessionId, conversationId, process, workDir, outputFile);

        } catch (IOException e) {
            throw new RuntimeException("Failed to create shell session: " + e.getMessage(), e);
        }
    }

    private void configureUserHome(Map<String, String> env, Long userId) throws IOException {
        Path userHome = runtimeDataResolver.resolveUserHomeDir(userId);
        if (userHome == null) {
            return;
        }
        Files.createDirectories(userHome);
        try {
            Files.setPosixFilePermissions(userHome, PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException ignored) {
            // Windows 等不支持 POSIX 权限的文件系统
        }
        env.put("HOME", userHome.toString());
        pathSandbox.addAllowedRoot(userHome);
    }

    private void configureGitCredentials(Map<String, String> env, Long userId, Long sessionId,
                                         Map<String, String> domainTokenMap) throws IOException {
        for (Map.Entry<String, String> entry : domainTokenMap.entrySet()) {
            env.put(GitCredentialService.envVarNameForDomain(entry.getKey()), entry.getValue());
        }

        Path askPassScript = runtimeDataResolver.resolveGitAskpassScript(userId, sessionId);
        Files.createDirectories(askPassScript.getParent());
        Files.writeString(askPassScript, GIT_ASKPASS_SCRIPT);
        try {
            Files.setPosixFilePermissions(askPassScript,
                    PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException e) {
            askPassScript.toFile().setExecutable(true, false);
        }

        env.put("GIT_ASKPASS", askPassScript.toAbsolutePath().toString());
        env.put("GIT_TERMINAL_PROMPT", "0");
    }

    private static final String GIT_ASKPASS_SCRIPT = """
            #!/bin/bash
            PROMPT="$1"
            if echo "$PROMPT" | grep -qi 'username'; then
              echo "oauth2"
              exit 0
            fi
            HOST=$(echo "$PROMPT" | sed -n "s/.*'https:\\/\\/\\([^/'\\"]*\\)'.*/\\1/p")
            if [ -z "$HOST" ]; then
              HOST=$(echo "$PROMPT" | sed -n "s/.*'http:\\/\\/\\([^/'\\"]*\\)'.*/\\1/p")
            fi
            if [ -z "$HOST" ]; then
              exit 1
            fi
            VARNAME="GIT_TOKEN_$(echo "$HOST" | tr '.-' '__')"
            VALUE="${!VARNAME}"
            if [ -n "$VALUE" ]; then
              echo "$VALUE"
            fi
            """;

    private void removeSession(String sessionId) {
        ShellSession session = sessions.remove(sessionId);
        if (session != null) {
            session.close();

            Set<String> convSessions = conversationSessions.get(session.getConversationId());
            if (convSessions != null) {
                convSessions.remove(sessionId);
                if (convSessions.isEmpty()) {
                    conversationSessions.remove(session.getConversationId());
                }
            }
        }
    }
}
