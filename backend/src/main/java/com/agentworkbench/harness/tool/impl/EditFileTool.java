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
import java.util.Map;

@Slf4j
@Component
public class EditFileTool implements Tool {

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;

    public EditFileTool(ObjectMapper objectMapper, PathSandbox pathSandbox) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
    }

    @Override
    public String getName() {
        return "edit_file";
    }

    @Override
    public String getDescription() {
        return "Edit a file by replacing an exact string match with new content. Parameters: path (required), old_string (required), new_string (required).";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "File path relative to workspace root"));
        properties.put("old_string", Map.of("type", "string", "description", "Exact string to find and replace"));
        properties.put("new_string", Map.of("type", "string", "description", "Replacement string"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"path", "old_string", "new_string"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("success", Map.of("type", "boolean"));
        properties.put("replacements", Map.of("type", "integer"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String path = args.get("path").asText();
            String oldString = args.get("old_string").asText();
            String newString = args.get("new_string").asText();

            Path filePath = pathSandbox.resolve(path);

            if (!Files.exists(filePath)) {
                return objectMapper.writeValueAsString(Map.of(
                        "success", false,
                        "replacements", 0,
                        "error", "File not found: " + path
                ));
            }

            String content = Files.readString(filePath);

            if (!content.contains(oldString)) {
                return objectMapper.writeValueAsString(Map.of(
                        "success", false,
                        "replacements", 0,
                        "error", "old_string not found in file"
                ));
            }

            String updated = content.replace(oldString, newString);
            int replacements = countOccurrences(content, oldString);
            Files.writeString(filePath, updated);

            return objectMapper.writeValueAsString(Map.of(
                    "success", true,
                    "replacements", replacements
            ));
        } catch (IOException e) {
            log.error("EditFileTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "success", false,
                        "replacements", 0,
                        "error", e.getMessage()
                ));
            } catch (Exception ex) {
                return "{\"success\":false,\"replacements\":0,\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
            }
        }
    }

    private int countOccurrences(String text, String search) {
        int count = 0;
        int idx = 0;
        while ((idx = text.indexOf(search, idx)) != -1) {
            count++;
            idx += search.length();
        }
        return count;
    }
}
