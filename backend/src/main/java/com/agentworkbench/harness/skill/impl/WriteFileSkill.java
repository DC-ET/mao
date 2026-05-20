package com.agentworkbench.harness.skill.impl;

import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.skill.Skill;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

@Slf4j
@Component
public class WriteFileSkill implements Skill {

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;

    public WriteFileSkill(ObjectMapper objectMapper, PathSandbox pathSandbox) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
    }

    @Override
    public String getName() {
        return "write_file";
    }

    @Override
    public String getDescription() {
        return "Write content to a file (creates or overwrites). Creates parent directories if needed. Parameters: path (required), content (required).";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "File path relative to workspace root"));
        properties.put("content", Map.of("type", "string", "description", "Content to write to the file"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"path", "content"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("success", Map.of("type", "boolean"));
        properties.put("bytes_written", Map.of("type", "integer"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String path = args.get("path").asText();
            String content = args.get("content").asText();

            Path filePath = pathSandbox.resolve(path);

            // Create parent directories if needed
            Path parent = filePath.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
            }

            Files.writeString(filePath, content);

            return objectMapper.writeValueAsString(Map.of(
                    "success", true,
                    "bytes_written", content.length()
            ));
        } catch (IOException e) {
            log.error("WriteFileSkill execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "success", false,
                        "bytes_written", 0,
                        "error", e.getMessage()
                ));
            } catch (Exception ex) {
                return "{\"success\":false,\"bytes_written\":0,\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
            }
        }
    }
}
