package cn.etarch.mao.harness.shell;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;

/**
 * 封装一个持久化的 Shell 会话（bash 进程）
 */
@Slf4j
@Getter
public class ShellSession implements Closeable {

    private final String sessionId;
    private final Long conversationId;
    private final Process process;
    private final BufferedWriter stdin;
    private final BufferedReader stdout;
    private final Path workspaceDir;
    private final Path outputFile;
    private final Instant createdAt;

    private volatile Instant lastActiveAt;
    private volatile boolean alive = true;
    private volatile String currentWorkdir;
    private int commandCount = 0;

    public ShellSession(String sessionId, Long conversationId,
                        Process process, Path workspaceDir, Path outputFile) {
        this.sessionId = sessionId;
        this.conversationId = conversationId;
        this.process = process;
        this.stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        this.stdout = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        this.workspaceDir = workspaceDir;
        this.outputFile = outputFile;
        this.createdAt = Instant.now();
        this.lastActiveAt = createdAt;
        this.currentWorkdir = workspaceDir.toString();
    }

    /**
     * 更新最后活跃时间
     */
    public void touch() {
        this.lastActiveAt = Instant.now();
    }

    /**
     * 检查会话是否存活
     */
    public boolean isAlive() {
        return alive && process.isAlive();
    }

    /**
     * 检查会话是否空闲超时
     */
    public boolean isIdleTimeout(Duration timeout) {
        return Duration.between(lastActiveAt, Instant.now()).compareTo(timeout) > 0;
    }

    /**
     * 检查会话是否超过最大生命周期
     */
    public boolean isExpired(Duration maxLifetime) {
        return Duration.between(createdAt, Instant.now()).compareTo(maxLifetime) > 0;
    }

    /**
     * 递增命令计数
     */
    public void incrementCommandCount() {
        commandCount++;
    }

    /**
     * 更新当前工作目录
     */
    public void setCurrentWorkdir(String workdir) {
        this.currentWorkdir = workdir;
    }

    /**
     * 关闭会话
     */
    @Override
    public void close() {
        if (!alive) {
            return;
        }
        alive = false;

        // 先销毁整个进程树（bash 及其后代进程），停止一切输出。
        // 若 bash 已退出但子进程（如 gradle）残留，管道不会 EOF，readUntilMarker 会一直空等。
        if (process.isAlive()) {
            try {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
            } catch (Exception e) {
                log.debug("Failed to destroy process tree for session {}: {}", sessionId, e.getMessage());
            }
            process.destroyForcibly();
            try {
                process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        // 进程已终止：把 stdout 中尚未被消费的输出保存到会话日志（进程死后 read 不阻塞）
        drainPendingOutput();

        try {
            // 关闭 stdin
            stdin.close();
        } catch (IOException e) {
            log.debug("Failed to close stdin for session {}: {}", sessionId, e.getMessage());
        }

        try {
            // 关闭 stdout
            stdout.close();
        } catch (IOException e) {
            log.debug("Failed to close stdout for session {}: {}", sessionId, e.getMessage());
        }

        log.info("Closed shell session: {}", sessionId);
    }

    /**
     * 会话关闭前，把 stdout 中尚未被消费的输出尽量保存到会话日志（{@link #outputFile}）。
     * 仅非阻塞读取当前已就绪的数据，不等待新输出；带时间与大小上限，避免被持续输出阻塞 close。
     */
    private void drainPendingOutput() {
        char[] buf = new char[8192];
        StringBuilder pending = new StringBuilder();
        long drainStart = System.currentTimeMillis();
        long drainLimitMs = 1000;
        int maxChars = 100_000;
        try {
            while (stdout.ready()
                    && System.currentTimeMillis() - drainStart < drainLimitMs
                    && pending.length() < maxChars) {
                int n = stdout.read(buf);
                if (n <= 0) {
                    break;
                }
                pending.append(buf, 0, n);
            }
        } catch (IOException e) {
            log.debug("Failed to drain pending output for session {}: {}", sessionId, e.getMessage());
        }
        if (pending.length() == 0) {
            return;
        }
        try {
            Files.createDirectories(outputFile.getParent());
            try (Writer writer = Files.newBufferedWriter(outputFile, StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND)) {
                writer.write(pending.toString());
            }
            log.info("Persisted {} chars of pending output for session {}", pending.length(), sessionId);
        } catch (IOException e) {
            log.debug("Failed to persist pending output for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 获取进程 PID（如果可用）
     */
    public long getPid() {
        try {
            return process.pid();
        } catch (UnsupportedOperationException e) {
            return -1;
        }
    }
}
