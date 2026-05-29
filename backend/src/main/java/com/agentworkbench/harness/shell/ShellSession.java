package com.agentworkbench.harness.shell;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.io.*;
import java.nio.charset.StandardCharsets;
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

    // 输出序号，用于生成唯一的输出文件名
    private int outputSequence = 0;

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
     * 获取下一个输出文件路径
     */
    public Path nextOutputFile() {
        outputSequence++;
        String fileName = String.format("%s_%d.out", sessionId, outputSequence);
        return outputFile.getParent().resolve(fileName);
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

        // 终止进程
        if (process.isAlive()) {
            process.destroyForcibly();
            try {
                process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        log.info("Closed shell session: {}", sessionId);
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
