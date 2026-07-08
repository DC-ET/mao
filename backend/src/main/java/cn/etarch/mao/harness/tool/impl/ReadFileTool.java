package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
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
        return "读取文件内容。支持文本文件（可按行 offset/limit）和图片文件（png/jpg/gif/webp）。参数：path（必填）、offset（可选，文本专用）、limit（可选，文本专用）。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("path", Map.of("type", "string", "description", "相对于工作区根目录的文件路径"));
        properties.put("offset", Map.of("type", "integer", "description", "开始读取的行号（从 0 开始），仅文本文件"));
        properties.put("limit", Map.of("type", "integer", "description", "最多读取的行数，仅文本文件"));
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

            Optional<String> imageMime = ImageFileSupport.mimeFromPath(path);
            if (imageMime.isPresent()) {
                return readImage(filePath, path, imageMime.get());
            }

            int offset = args.has("offset") ? args.get("offset").asInt() : 0;
            int limit = args.has("limit") ? args.get("limit").asInt() : Integer.MAX_VALUE;

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

    private String readImage(Path filePath, String path, String expectedMime) throws Exception {
        long sizeBytes = Files.size(filePath);
        if (sizeBytes > ImageFileSupport.MAX_IMAGE_BYTES) {
            return objectMapper.writeValueAsString(Map.of(
                    "content", "错误：文件过大（" + ImageFileSupport.formatSize(sizeBytes)
                            + "），图片读取上限为 " + ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES) + "：" + path,
                    "total_lines", 0
            ));
        }

        byte[] bytes = Files.readAllBytes(filePath);
        Optional<String> detectedMime = ImageFileSupport.detectMimeFromBytes(bytes);
        if (detectedMime.isEmpty()) {
            return objectMapper.writeValueAsString(Map.of(
                    "content", "错误：不支持的图片格式或文件内容无效：" + path,
                    "total_lines", 0
            ));
        }

        String mime = detectedMime.get();
        String encoded = Base64.getEncoder().encodeToString(bytes);
        String dataUri = "data:" + mime + ";base64," + encoded;

        Integer width = null;
        Integer height = null;
        try {
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
            if (image != null) {
                width = image.getWidth();
                height = image.getHeight();
            }
        } catch (Exception e) {
            log.debug("Failed to read image dimensions for {}", path, e);
        }

        StringBuilder summary = new StringBuilder("图片读取成功：")
                .append(path)
                .append(" (")
                .append(mime)
                .append(", ")
                .append(ImageFileSupport.formatSize(sizeBytes));
        if (width != null && height != null) {
            summary.append(", ").append(width).append("×").append(height);
        }
        summary.append(")");

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("content", summary.toString());
        result.put("total_lines", 0);
        result.put("media_type", "image");
        result.put("mime", mime);
        result.put("path", path);
        result.put("size_bytes", sizeBytes);
        if (width != null) {
            result.put("width", width);
        }
        if (height != null) {
            result.put("height", height);
        }
        result.put("data_uri", dataUri);
        return objectMapper.writeValueAsString(result);
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
