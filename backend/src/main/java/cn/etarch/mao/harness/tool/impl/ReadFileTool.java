package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

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
        return "读取文件内容。参数：path（必填）、offset（可选，起始行号）、limit（可选，最多读取行数）。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "相对于工作区根目录的文件路径"));
        properties.put("offset", Map.of("type", "integer", "description", "开始读取的行号（从 0 开始）"));
        properties.put("limit", Map.of("type", "integer", "description", "最多读取的行数"));
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
            String path = extractPath(args);
            if (path == null) {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "错误：缺少必填参数 path",
                        "total_lines", 0
                ));
            }
            int offset = args.has("offset") ? args.get("offset").asInt() : 0;
            int limit = args.has("limit") ? args.get("limit").asInt() : Integer.MAX_VALUE;

            Path filePath = pathSandbox.resolve(path, workspace);

            if (!Files.exists(filePath)) {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "错误：文件不存在：" + path,
                        "total_lines", 0
                ));
            }

            if (!Files.isRegularFile(filePath)) {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "错误：不是普通文件：" + path,
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
        } catch (Exception e) {
            log.error("ReadFileTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "content", "错误：" + e.getMessage(),
                        "total_lines", 0
                ));
            } catch (Exception ex) {
                return "{\"content\":\"错误：" + e.getMessage().replace("\"", "'") + "\",\"total_lines\":0}";
            }
        }
    }

    private String extractPath(JsonNode args) {
        if (args == null || !args.isObject()) {
            return null;
        }
        for (String key : List.of("path", "file", "filePath", "file_path", "target_file")) {
            JsonNode node = args.get(key);
            if (node != null && !node.isNull()) {
                String value = node.asText();
                if (value != null && !value.isBlank()) {
                    return value;
                }
            }
        }
        return null;
    }
}
