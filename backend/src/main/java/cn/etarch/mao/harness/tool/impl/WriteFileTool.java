package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.FileChangeDiffUtil;
import cn.etarch.mao.harness.tool.Tool;
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
public class WriteFileTool implements Tool {

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;

    public WriteFileTool(ObjectMapper objectMapper, PathSandbox pathSandbox) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
    }

    @Override
    public String getName() {
        return "write_file";
    }

    @Override
    public String getDescription() {
        return "将内容写入文件（创建或覆盖）。如有需要会创建父目录。参数：path（必填）、content（必填）。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "相对于工作区根目录的文件路径"));
        properties.put("content", Map.of("type", "string", "description", "要写入文件的内容"));
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
        return execute(arguments, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String path = args.get("path").asText();
            String content = args.get("content").asText();

            Path filePath = pathSandbox.resolve(path, workspace);

            // Snapshot before write for change tracking
            boolean fileExisted = Files.exists(filePath);
            String beforeContent = "";
            if (fileExisted) {
                beforeContent = Files.readString(filePath);
            }

            Path parent = filePath.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
            }

            Files.writeString(filePath, content);

            // Compute file change stats
            int newLineCount = content.isEmpty() ? 0 : content.split("\n", -1).length;
            FileChangeDiffUtil.LineDelta lineDelta = fileExisted
                    ? FileChangeDiffUtil.computeLineDelta(beforeContent, content)
                    : new FileChangeDiffUtil.LineDelta(newLineCount, 0);
            int linesAdded = lineDelta.linesAdded();
            int linesDeleted = lineDelta.linesDeleted();
            String changeType = fileExisted ? "MODIFIED" : "CREATED";

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("bytes_written", content.length());
            result.put("file_change", Map.of(
                    "path", path,
                    "type", changeType,
                    "total_lines", newLineCount,
                    "lines_added", linesAdded,
                    "lines_deleted", linesDeleted
            ));
            result.put(FileChangeDiffUtil.PRIVATE_DIFF_FIELD,
                    FileChangeDiffUtil.buildDiff(path, beforeContent, content));
            return objectMapper.writeValueAsString(result);
        } catch (IOException e) {
            log.error("WriteFileTool execution failed", e);
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
