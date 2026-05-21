package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.core.BackgroundTaskManager;
import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Slf4j
@Component
public class BashTool implements Tool {

    private static final int DEFAULT_TIMEOUT_SECONDS = 30;
    private static final int MAX_OUTPUT_LENGTH = 50000;

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;
    private final BackgroundTaskManager backgroundTaskManager;

    public BashTool(ObjectMapper objectMapper, PathSandbox pathSandbox, BackgroundTaskManager backgroundTaskManager) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
        this.backgroundTaskManager = backgroundTaskManager;
    }

    @Override
    public String getName() {
        return "bash";
    }

    @Override
    public String getDescription() {
        return "Execute a shell command and return its output. Parameters: command (required), timeout (optional, default 30s), workdir (optional), async (optional, default false - run in background and return task_id).";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("command", Map.of("type", "string", "description", "The shell command to execute"));
        properties.put("timeout", Map.of("type", "integer", "description", "Timeout in seconds (default 30)"));
        properties.put("workdir", Map.of("type", "string", "description", "Working directory (relative to workspace root)"));
        properties.put("async", Map.of("type", "boolean", "description", "Run in background (default false)"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"command"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("exit_code", Map.of("type", "integer"));
        properties.put("output", Map.of("type", "string"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String command = args.get("command").asText();
            int timeout = args.has("timeout") ? args.get("timeout").asInt() : DEFAULT_TIMEOUT_SECONDS;
            String workdir = args.has("workdir") ? args.get("workdir").asText() : null;
            boolean async = args.has("async") && args.get("async").asBoolean();

            if (async) {
                String taskId = backgroundTaskManager.submit(() -> executeCommand(command, timeout, workdir, workspace));
                return objectMapper.writeValueAsString(Map.of(
                        "async", true,
                        "task_id", taskId,
                        "message", "Command submitted for background execution. Result will be injected automatically."
                ));
            }

            return executeCommand(command, timeout, workdir, workspace);
        } catch (Exception e) {
            log.error("BashTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "exit_code", -1,
                        "output", "Error: " + e.getMessage()
                ));
            } catch (Exception ex) {
                return "{\"exit_code\":-1,\"output\":\"Error: " + e.getMessage().replace("\"", "'") + "\"}";
            }
        }
    }

    private String executeCommand(String command, int timeout, String workdir, String workspace) throws Exception {
        ProcessBuilder pb = new ProcessBuilder("bash", "-c", command);
        pb.redirectErrorStream(true);

        if (workdir != null) {
            File dir = pathSandbox.resolve(workdir, workspace).toFile();
            if (!dir.isDirectory()) {
                return objectMapper.writeValueAsString(Map.of(
                        "exit_code", -1,
                        "output", "Error: working directory does not exist: " + workdir
                ));
            }
            pb.directory(dir);
        } else {
            pb.directory(pathSandbox.getEffectiveWorkspaceRoot(workspace).toFile());
        }

        Process process = pb.start();
        boolean finished = process.waitFor(timeout, TimeUnit.SECONDS);

        if (!finished) {
            process.destroyForcibly();
            return objectMapper.writeValueAsString(Map.of(
                    "exit_code", -1,
                    "output", "Error: command timed out after " + timeout + " seconds"
            ));
        }

        String output = readStream(process.getInputStream());
        if (output.length() > MAX_OUTPUT_LENGTH) {
            output = output.substring(0, MAX_OUTPUT_LENGTH) + "\n... [output truncated]";
        }

        return objectMapper.writeValueAsString(Map.of(
                "exit_code", process.exitValue(),
                "output", output
        ));
    }

    private String readStream(InputStream is) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
            return sb.toString();
        }
    }
}
