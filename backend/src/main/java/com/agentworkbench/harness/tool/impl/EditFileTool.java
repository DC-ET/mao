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
        return "通过精确匹配字符串并替换为新内容来编辑文件。参数：path（必填）、old_string（必填）、new_string（必填）。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "相对于工作区根目录的文件路径"));
        properties.put("old_string", Map.of("type", "string", "description", "需要查找并替换的精确字符串"));
        properties.put("new_string", Map.of("type", "string", "description", "替换后的字符串"));
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
        return execute(arguments, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String path = args.get("path").asText();
            String oldString = args.get("old_string").asText();
            String newString = args.get("new_string").asText();

            Path filePath = pathSandbox.resolve(path, workspace);

            if (!Files.exists(filePath)) {
                return objectMapper.writeValueAsString(Map.of(
                        "success", false,
                        "replacements", 0,
                        "error", "文件不存在：" + path
                ));
            }

            String content = Files.readString(filePath);

            if (!content.contains(oldString)) {
                return objectMapper.writeValueAsString(Map.of(
                        "success", false,
                        "replacements", 0,
                        "error", "文件中未找到 old_string"
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
