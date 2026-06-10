package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.core.BackgroundTaskManager;
import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.shell.OutputManager;
import com.agentworkbench.harness.shell.OutputManager.OutputResult;
import com.agentworkbench.harness.shell.ShellSession;
import com.agentworkbench.harness.shell.ShellSessionManager;
import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 唯一的命令执行工具：支持一次性执行和有状态持久会话
 */
@Slf4j
@Component
public class ShellSessionTool implements Tool {

    private static final int MAX_COMMAND_LENGTH = 10000;
    private static final String MARKER_PREFIX = "__CMD_DONE_";
    private static final String MARKER_SUFFIX = "__";

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;
    private final ShellSessionManager sessionManager;
    private final OutputManager outputManager;
    private final BackgroundTaskManager backgroundTaskManager;

    public ShellSessionTool(ObjectMapper objectMapper, PathSandbox pathSandbox,
                            ShellSessionManager sessionManager, OutputManager outputManager,
                            BackgroundTaskManager backgroundTaskManager) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
        this.sessionManager = sessionManager;
        this.outputManager = outputManager;
        this.backgroundTaskManager = backgroundTaskManager;
    }

    @Override
    public String getName() {
        return "shell";
    }

    @Override
    public String getDescription() {
        return "执行 shell 命令，支持一次性执行和持久会话。\n" +
                "动作：\n" +
                "- exec：执行命令（如果省略 session_id，则创建新会话）\n" +
                "- write_stdin：向正在运行的会话 stdin 写入输入\n" +
                "- close：关闭 shell 会话\n" +
                "- list：列出活跃会话";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");

        Map<String, Object> properties = new HashMap<>();

        Map<String, Object> action = new HashMap<>();
        action.put("type", "string");
        action.put("enum", List.of("exec", "write_stdin", "close", "list"));
        action.put("description", "要执行的动作（默认：exec）");
        properties.put("action", action);

        Map<String, Object> command = new HashMap<>();
        command.put("type", "string");
        command.put("description", "要执行的命令（用于 exec 动作）");
        properties.put("command", command);

        Map<String, Object> sessionId = new HashMap<>();
        sessionId.put("type", "string");
        sessionId.put("description", "会话 ID。省略时执行一次性命令；提供时复用已有会话。");
        properties.put("session_id", sessionId);

        Map<String, Object> input = new HashMap<>();
        input.put("type", "string");
        input.put("description", "要写入 stdin 的输入（用于 write_stdin 动作）");
        properties.put("input", input);

        Map<String, Object> workdir = new HashMap<>();
        workdir.put("type", "string");
        workdir.put("description", "工作目录（相对于工作区）");
        properties.put("workdir", workdir);

        Map<String, Object> yieldTimeMs = new HashMap<>();
        yieldTimeMs.put("type", "integer");
        yieldTimeMs.put("description", "等待输出的最长时间，单位毫秒（默认 10000）");
        properties.put("yield_time_ms", yieldTimeMs);

        Map<String, Object> async = new HashMap<>();
        async.put("type", "boolean");
        async.put("description", "是否在后台运行并立即返回 task_id（默认 false，仅用于 exec 动作）");
        properties.put("async", async);

        schema.put("properties", properties);

        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("exit_code", Map.of("type", "integer"));
        properties.put("session_id", Map.of("type", "string"));
        properties.put("output", Map.of("type", "string"));
        properties.put("current_workdir", Map.of("type", "string"));
        properties.put("truncated", Map.of("type", "boolean"));
        properties.put("async", Map.of("type", "boolean"));
        properties.put("task_id", Map.of("type", "string"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        return execute(arguments, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String action = args.path("action").asText("exec");
            if (action.isBlank()) {
                action = "exec";
            }

            return switch (action) {
                case "exec" -> handleExec(args, sessionId, workspace);
                case "write_stdin" -> handleWriteStdin(args, sessionId);
                case "close" -> handleClose(args, sessionId);
                case "list" -> handleList(sessionId);
                default -> errorJson("未知动作：" + action);
            };
        } catch (Exception e) {
            log.error("ShellSessionTool execution failed", e);
            return errorJson("错误：" + e.getMessage());
        }
    }

    private String handleExec(JsonNode args, Long conversationId, String workspace) throws Exception {
        String command = args.has("command") ? args.get("command").asText() : null;
        if (command == null || command.isBlank()) {
            return errorJson("exec 动作必须提供 command");
        }
        if (command.length() > MAX_COMMAND_LENGTH) {
            return errorJson("命令过长（最多 " + MAX_COMMAND_LENGTH + " 个字符）");
        }

        String sessionId = args.has("session_id") ? args.get("session_id").asText() : null;
        int yieldTimeMs = args.has("yield_time_ms") ? args.get("yield_time_ms").asInt() : 10000;
        String workdir = args.has("workdir") ? args.get("workdir").asText() : null;
        boolean isAsync = args.has("async") && args.get("async").asBoolean();

        // async 模式：提交后台任务，立即返回
        if (isAsync) {
            String taskId = backgroundTaskManager.submit(() -> {
                try {
                    return doExec(command, sessionId, conversationId, workspace, workdir, yieldTimeMs);
                } catch (Exception e) {
                    return errorJson("异步执行失败：" + e.getMessage());
                }
            });
            return objectMapper.writeValueAsString(Map.of(
                    "async", true,
                    "task_id", taskId,
                    "message", "命令已提交到后台执行。"
            ));
        }

        return doExec(command, sessionId, conversationId, workspace, workdir, yieldTimeMs);
    }

    private String doExec(String command, String sessionId, Long conversationId,
                          String workspace, String workdir, int yieldTimeMs) throws Exception {
        // 获取或创建会话
        ShellSession session = sessionManager.getOrCreate(conversationId, sessionId, workspace);
        sessionId = session.getSessionId();

        // 如果指定了工作目录，先执行 cd
        if (workdir != null) {
            Path resolvedWorkdir = pathSandbox.resolve(workdir, workspace);
            executeWithMarker(session, "cd " + resolvedWorkdir, Duration.ofSeconds(5));
        }

        // 执行命令
        long startTime = System.currentTimeMillis();
        OutputResult output = executeWithMarker(session, command, Duration.ofMillis(yieldTimeMs));
        long elapsedMs = System.currentTimeMillis() - startTime;

        String currentWorkdir = pwdWithMarker(session);

        String result = outputManager.formatToolResult(
                output.markerFound() ? 0 : -1,
                sessionId,
                elapsedMs,
                output,
                currentWorkdir
        );

        session.incrementCommandCount();
        return result;
    }

    private String handleWriteStdin(JsonNode args, Long conversationId) throws Exception {
        String sessionId = args.has("session_id") ? args.get("session_id").asText() : null;
        if (sessionId == null) {
            return errorJson("write_stdin 动作必须提供 session_id");
        }

        String input = args.has("input") ? args.get("input").asText() : null;
        if (input == null) {
            return errorJson("write_stdin 动作必须提供 input");
        }

        int yieldTimeMs = args.has("yield_time_ms") ? args.get("yield_time_ms").asInt() : 5000;

        ShellSession session = sessionManager.getSession(sessionId);
        if (session == null) {
            return errorJson("会话不存在：" + sessionId);
        }

        // 写入输入，用 marker 检测输出结束
        String marker = generateMarker();
        session.getStdin().write(input);
        session.getStdin().newLine();
        session.getStdin().flush();
        // 写入 marker 以便检测输出结束
        session.getStdin().write("echo " + MARKER_PREFIX + marker + MARKER_SUFFIX);
        session.getStdin().newLine();
        session.getStdin().flush();

        Path outputFile = session.nextOutputFile();
        String fullMarker = MARKER_PREFIX + marker + MARKER_SUFFIX;
        OutputResult output = outputManager.readUntilMarker(session.getStdout(), fullMarker,
                Duration.ofMillis(yieldTimeMs), outputFile);
        String currentWorkdir = pwdWithMarker(session);

        session.touch();
        return objectMapper.writeValueAsString(Map.of(
                "session_id", sessionId,
                "current_workdir", currentWorkdir != null ? currentWorkdir : "",
                "output", output.preview(),
                "truncated", output.truncated()
        ));
    }

    private String handleClose(JsonNode args, Long conversationId) throws Exception {
        String sessionId = args.has("session_id") ? args.get("session_id").asText() : null;
        if (sessionId == null) {
            return errorJson("close 动作必须提供 session_id");
        }

        sessionManager.close(sessionId);
        return objectMapper.writeValueAsString(Map.of(
                "session_id", sessionId,
                "status", "已关闭"
        ));
    }

    private String handleList(Long conversationId) throws Exception {
        List<ShellSession> sessions = sessionManager.listByConversation(conversationId);

        List<Map<String, Object>> sessionList = sessions.stream()
                .map(s -> {
                    Map<String, Object> info = new HashMap<>();
                    info.put("session_id", s.getSessionId());
                    info.put("current_workdir", s.getCurrentWorkdir());
                    info.put("command_count", s.getCommandCount());
                    info.put("created_at", s.getCreatedAt().toString());
                    return info;
                })
                .toList();

        return objectMapper.writeValueAsString(Map.of(
                "sessions", sessionList,
                "count", sessionList.size()
        ));
    }

    /**
     * 用 marker 机制执行命令并读取输出
     */
    private OutputResult executeWithMarker(ShellSession session, String command, Duration timeout) {
        String marker = generateMarker();
        String fullMarker = MARKER_PREFIX + marker + MARKER_SUFFIX;

        log.info("executeWithMarker: session={}, command={}, timeoutMs={}, marker={}",
                session.getSessionId(), command, timeout.toMillis(), fullMarker);

        try {
            // 写入命令 + marker echo
            session.getStdin().write(command);
            session.getStdin().newLine();
            session.getStdin().write("echo " + fullMarker);
            session.getStdin().newLine();
            session.getStdin().flush();

            Path outputFile = session.nextOutputFile();
            return outputManager.readUntilMarker(session.getStdout(), fullMarker, timeout, outputFile);
        } catch (Exception e) {
            log.error("Failed to execute command in session {}: {}", session.getSessionId(), e.getMessage());
            return new OutputResult("错误：" + e.getMessage(), 0, 0, false, false, null);
        }
    }

    /**
     * 用 marker 机制获取当前工作目录
     */
    private String pwdWithMarker(ShellSession session) {
        String marker = generateMarker();
        String fullMarker = MARKER_PREFIX + marker + MARKER_SUFFIX;

        try {
            session.getStdin().write("pwd");
            session.getStdin().newLine();
            session.getStdin().write("echo " + fullMarker);
            session.getStdin().newLine();
            session.getStdin().flush();

            OutputResult result = outputManager.readUntilMarker(
                    session.getStdout(), fullMarker, Duration.ofSeconds(5), null);

            String output = result.preview();
            if (output != null && !output.isEmpty()) {
                String[] lines = output.split("\n");
                // pwd 输出在 marker 之前最后一行
                for (int i = lines.length - 1; i >= 0; i--) {
                    String line = lines[i].trim();
                    if (!line.isEmpty() && !line.contains(MARKER_PREFIX)) {
                        session.setCurrentWorkdir(line);
                        return line;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Failed to get current workdir: {}", e.getMessage());
        }
        return session.getCurrentWorkdir();
    }

    private String generateMarker() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private String errorJson(String message) {
        try {
            return objectMapper.writeValueAsString(Map.of(
                    "exit_code", -1,
                    "error", message
            ));
        } catch (Exception e) {
            return "{\"exit_code\":-1,\"error\":\"" + message.replace("\"", "'") + "\"}";
        }
    }
}
