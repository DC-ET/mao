package com.agentworkbench.harness.tool.impl;

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

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 有状态的 Shell 会话工具，支持多轮操作
 */
@Slf4j
@Component
public class ShellSessionTool implements Tool {

    private static final int MAX_COMMAND_LENGTH = 10000;

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;
    private final ShellSessionManager sessionManager;
    private final OutputManager outputManager;

    public ShellSessionTool(ObjectMapper objectMapper, PathSandbox pathSandbox,
                            ShellSessionManager sessionManager, OutputManager outputManager) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
        this.sessionManager = sessionManager;
        this.outputManager = outputManager;
    }

    @Override
    public String getName() {
        return "shell";
    }

    @Override
    public String getDescription() {
        return "Shell tool with session persistence. Supports multi-step operations with state preservation.\n" +
                "Actions:\n" +
                "- exec: Execute a command in a shell session\n" +
                "- write_stdin: Write input to a running session's stdin\n" +
                "- close: Close a shell session\n" +
                "- list: List active sessions for current conversation";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");

        Map<String, Object> properties = new HashMap<>();

        Map<String, Object> action = new HashMap<>();
        action.put("type", "string");
        action.put("enum", List.of("exec", "write_stdin", "close", "list"));
        action.put("description", "Action to perform");
        properties.put("action", action);

        Map<String, Object> sessionId = new HashMap<>();
        sessionId.put("type", "string");
        sessionId.put("description", "Session ID. Omit to create new session, or provide to reuse existing.");
        properties.put("session_id", sessionId);

        Map<String, Object> command = new HashMap<>();
        command.put("type", "string");
        command.put("description", "Shell command to execute (for exec action)");
        properties.put("command", command);

        Map<String, Object> input = new HashMap<>();
        input.put("type", "string");
        input.put("description", "Input to write to stdin (for write_stdin action)");
        properties.put("input", input);

        Map<String, Object> workdir = new HashMap<>();
        workdir.put("type", "string");
        workdir.put("description", "Working directory (relative to workspace)");
        properties.put("workdir", workdir);

        Map<String, Object> yieldTimeMs = new HashMap<>();
        yieldTimeMs.put("type", "integer");
        yieldTimeMs.put("description", "Initial wait time for output in milliseconds (default 10000)");
        properties.put("yield_time_ms", yieldTimeMs);

        schema.put("properties", properties);
        schema.put("required", new String[]{"action"});

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
            String action = args.get("action").asText();

            return switch (action) {
                case "exec" -> handleExec(args, sessionId, workspace);
                case "write_stdin" -> handleWriteStdin(args, sessionId);
                case "close" -> handleClose(args, sessionId);
                case "list" -> handleList(sessionId);
                default -> errorJson("Unknown action: " + action);
            };
        } catch (Exception e) {
            log.error("ShellSessionTool execution failed", e);
            return errorJson("Error: " + e.getMessage());
        }
    }

    /**
     * 执行命令
     */
    private String handleExec(JsonNode args, Long conversationId, String workspace) throws Exception {
        // 解析参数
        String command = args.has("command") ? args.get("command").asText() : null;
        if (command == null || command.isBlank()) {
            return errorJson("command is required for exec action");
        }
        if (command.length() > MAX_COMMAND_LENGTH) {
            return errorJson("Command too long (max " + MAX_COMMAND_LENGTH + " chars)");
        }

        String sessionId = args.has("session_id") ? args.get("session_id").asText() : null;
        int yieldTimeMs = args.has("yield_time_ms") ? args.get("yield_time_ms").asInt() : 10000;
        String workdir = args.has("workdir") ? args.get("workdir").asText() : null;

        // 获取或创建会话
        ShellSession session = sessionManager.getOrCreate(conversationId, sessionId, workspace);
        sessionId = session.getSessionId();

        // 如果指定了工作目录，先执行 cd
        if (workdir != null) {
            Path resolvedWorkdir = pathSandbox.resolve(workdir, workspace);
            executeInSession(session, "cd " + resolvedWorkdir, Duration.ofSeconds(5));
        }

        // 执行命令
        long startTime = System.currentTimeMillis();
        OutputResult output = executeInSession(session, command, Duration.ofMillis(yieldTimeMs));
        long elapsedMs = System.currentTimeMillis() - startTime;

        // 获取当前工作目录
        String currentWorkdir = getCurrentWorkdir(session);

        // 格式化返回
        String result = outputManager.formatToolResult(
                0,  // exit_code 通过命令本身获取
                sessionId,
                elapsedMs,
                output,
                currentWorkdir
        );

        session.incrementCommandCount();
        return result;
    }

    /**
     * 写入 stdin
     */
    private String handleWriteStdin(JsonNode args, Long conversationId) throws Exception {
        String sessionId = args.has("session_id") ? args.get("session_id").asText() : null;
        if (sessionId == null) {
            return errorJson("session_id is required for write_stdin action");
        }

        String input = args.has("input") ? args.get("input").asText() : null;
        if (input == null) {
            return errorJson("input is required for write_stdin action");
        }

        int yieldTimeMs = args.has("yield_time_ms") ? args.get("yield_time_ms").asInt() : 5000;

        // 获取会话
        ShellSession session = sessionManager.getSession(sessionId);
        if (session == null) {
            return errorJson("Session not found: " + sessionId);
        }

        // 写入输入并读取输出
        session.getStdin().write(input);
        session.getStdin().flush();

        Path outputFile = session.nextOutputFile();
        OutputResult output = outputManager.readOutput(session.getStdout(), outputFile, Duration.ofMillis(yieldTimeMs));
        String currentWorkdir = getCurrentWorkdir(session);

        return objectMapper.writeValueAsString(Map.of(
                "session_id", sessionId,
                "current_workdir", currentWorkdir != null ? currentWorkdir : "",
                "output", output.preview(),
                "truncated", output.truncated()
        ));
    }

    /**
     * 关闭会话
     */
    private String handleClose(JsonNode args, Long conversationId) throws Exception {
        String sessionId = args.has("session_id") ? args.get("session_id").asText() : null;
        if (sessionId == null) {
            return errorJson("session_id is required for close action");
        }

        sessionManager.close(sessionId);
        return objectMapper.writeValueAsString(Map.of(
                "session_id", sessionId,
                "status", "closed"
        ));
    }

    /**
     * 列出会话
     */
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
     * 在会话中执行命令并读取输出
     */
    private OutputResult executeInSession(ShellSession session, String command, Duration yieldTime)
            throws IOException, InterruptedException {
        // 写入命令
        session.getStdin().write(command);
        session.getStdin().newLine();
        session.getStdin().flush();

        // 读取输出
        Path outputFile = session.nextOutputFile();
        return outputManager.readOutput(session.getStdout(), outputFile, yieldTime);
    }

    /**
     * 获取当前工作目录
     */
    private String getCurrentWorkdir(ShellSession session) {
        try {
            // 执行 pwd 命令获取当前目录
            session.getStdin().write("pwd");
            session.getStdin().newLine();
            session.getStdin().flush();

            // 短暂等待
            Thread.sleep(100);

            // 读取输出
            StringBuilder sb = new StringBuilder();
            char[] buffer = new char[1024];
            while (session.getStdout().ready()) {
                int charsRead = session.getStdout().read(buffer);
                if (charsRead == -1) break;
                sb.append(buffer, 0, charsRead);
            }

            // 提取最后一行作为工作目录
            String output = sb.toString().trim();
            String[] lines = output.split("\n");
            if (lines.length > 0) {
                String workdir = lines[lines.length - 1].trim();
                session.setCurrentWorkdir(workdir);
                return workdir;
            }
        } catch (Exception e) {
            log.debug("Failed to get current workdir: {}", e.getMessage());
        }
        return session.getCurrentWorkdir();
    }

    /**
     * 生成错误 JSON
     */
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
