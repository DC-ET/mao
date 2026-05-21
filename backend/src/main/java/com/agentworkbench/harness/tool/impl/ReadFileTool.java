package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

@Slf4j
@Component
public class ReadFileTool implements Tool {

    private static final int MAX_OUTPUT_LENGTH = 50000;

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;

    public ReadFileTool(ObjectMapper objectMapper, PathSandbox pathSandbox) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
    }

    @Override
    public String getName() {
        return "read_file";
    }

    @Override
    public String getDescription() {
        return "Read the contents of a file. Parameters: path (required), offset (optional, line number to start from), limit (optional, max lines to read).";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "File path relative to workspace root"));
        properties.put("offset", Map.of("type", "integer", "description", "Line number to start reading from (0-based)"));
        properties.put("limit", Map.of("type", "integer", "description", "Maximum number of lines to read"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"path"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("content", Map.of("type", "string"));
        properties.put("total_lines", Map.of("type", "integer"));
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
            String path = args.get("path").asText();
            int offset = args.has("offset") ? args.get("offset").asInt() : 0;
            int limit = args.has("limit") ? args.get("limit").asInt() : Integer.MAX_VALUE;

            Path filePath = pathSandbox.resolve(path, workspace);

            if (!Files.exists(filePath)) {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "Error: file not found: " + path,
                        "total_lines", 0
                ));
            }

            if (!Files.isRegularFile(filePath)) {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "Error: not a regular file: " + path,
                        "total_lines", 0
                ));
            }

            List<String> allLines;
            try (Stream<String> lines = Files.lines(filePath)) {
                allLines = lines.collect(Collectors.toList());
            }

            int totalLines = allLines.size();
            int from = Math.min(offset, totalLines);
            int to = Math.min(from + limit, totalLines);

            String content = String.join("\n", allLines.subList(from, to));
            if (content.length() > MAX_OUTPUT_LENGTH) {
                content = content.substring(0, MAX_OUTPUT_LENGTH) + "\n... [output truncated]";
            }

            return objectMapper.writeValueAsString(Map.of(
                    "content", content,
                    "total_lines", totalLines
            ));
        } catch (IOException e) {
            log.error("ReadFileTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "Error: " + e.getMessage(),
                        "total_lines", 0
                ));
            } catch (Exception ex) {
                return "{\"content\":\"Error: " + e.getMessage().replace("\"", "'") + "\",\"total_lines\":0}";
            }
        }
    }
}
