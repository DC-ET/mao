package com.agentworkbench.harness.shell;

import com.agentworkbench.harness.safety.PathSandbox;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Shell 会话管理器，负责会话的创建、获取、关闭和清理
 */
@Slf4j
@Component
public class ShellSessionManager {

    private static final String OUTPUT_DIR = ".workbench/shellOutput";

    private final PathSandbox pathSandbox;

    @Value("${app.harness.shell.max-sessions-per-conversation:30}")
    private int maxSessionsPerConversation;

    @Value("${app.harness.shell.session-idle-timeout-minutes:30}")
    private int sessionIdleTimeoutMinutes;

    @Value("${app.harness.shell.session-max-lifetime-hours:2}")
    private int sessionMaxLifetimeHours;

    // sessionId -> ShellSession
    private final ConcurrentHashMap<String, ShellSession> sessions = new ConcurrentHashMap<>();

    // conversationId -> Set<sessionId>
    private final ConcurrentHashMap<Long, Set<String>> conversationSessions = new ConcurrentHashMap<>();

    public ShellSessionManager(PathSandbox pathSandbox) {
        this.pathSandbox = pathSandbox;
    }

    /**
     * 获取或创建会话
     *
     * @param conversationId 对话 ID
     * @param sessionId      会话 ID（可选，为空则自动生成）
     * @param workspace      工作空间路径
     * @return ShellSession
     */
    public ShellSession getOrCreate(Long conversationId, String sessionId, String workspace) {
        // 如果 sessionId 已存在且存活，直接返回
        if (sessionId != null && sessions.containsKey(sessionId)) {
            ShellSession session = sessions.get(sessionId);
            if (session.isAlive()) {
                session.touch();
                return session;
            }
            // 会话已死亡，移除并创建新的
            removeSession(sessionId);
        }

        // 检查会话数限制
        Set<String> convSessions = conversationSessions.computeIfAbsent(conversationId, k -> ConcurrentHashMap.newKeySet());
        if (convSessions.size() >= maxSessionsPerConversation) {
            throw new IllegalStateException("Maximum number of shell sessions (" + maxSessionsPerConversation +
                    ") reached for conversation " + conversationId + ". Close existing sessions first.");
        }

        // 生成 sessionId
        if (sessionId == null) {
            sessionId = "sh-" + conversationId + "-" + System.currentTimeMillis();
        }

        // 创建新会话
        ShellSession session = createSession(sessionId, conversationId, workspace);

        // 注册会话
        sessions.put(sessionId, session);
        convSessions.add(sessionId);

        log.info("Created shell session: {} for conversation: {}", sessionId, conversationId);
        return session;
    }

    /**
     * 获取会话
     */
    public ShellSession getSession(String sessionId) {
        ShellSession session = sessions.get(sessionId);
        if (session == null || !session.isAlive()) {
            return null;
        }
        session.touch();
        return session;
    }

    /**
     * 关闭指定会话
     */
    public void close(String sessionId) {
        removeSession(sessionId);
    }

    /**
     * 关闭某个对话的所有会话
     */
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

    /**
     * 列出某个对话的所有活跃会话
     */
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

    /**
     * 清理过期会话（定时任务）
     */
    @Scheduled(fixedRate = 60000)  // 每分钟检查一次
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

    /**
     * 获取活跃会话数量
     */
    public int getActiveSessionCount() {
        return sessions.size();
    }

    /**
     * 创建新的 Shell 会话
     */
    private ShellSession createSession(String sessionId, Long conversationId, String workspace) {
        try {
            // 解析工作目录
            Path workDir = pathSandbox.getEffectiveWorkspaceRoot(workspace);

            // 确保输出目录存在
            Path outputDir = workDir.resolve(OUTPUT_DIR);
            Files.createDirectories(outputDir);

            // 创建输出文件占位（实际路径在 nextOutputFile 时生成）
            Path outputFile = outputDir.resolve(sessionId + ".out");

            // 构建 bash 命令
            ProcessBuilder pb = new ProcessBuilder();
            pb.command("bash", "--norc", "--noprofile");

            pb.directory(workDir.toFile());
            pb.redirectErrorStream(true);

            // 设置环境变量
            Map<String, String> env = pb.environment();
            env.put("TERM", "dumb");  // 避免 ANSI 转义序列
            env.put("PS1", "");       // 禁用提示符

            Process process = pb.start();

            return new ShellSession(sessionId, conversationId, process, workDir, outputFile);

        } catch (IOException e) {
            throw new RuntimeException("Failed to create shell session: " + e.getMessage(), e);
        }
    }

    /**
     * 移除并关闭会话
     */
    private void removeSession(String sessionId) {
        ShellSession session = sessions.remove(sessionId);
        if (session != null) {
            session.close();

            // 从对话索引中移除
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
