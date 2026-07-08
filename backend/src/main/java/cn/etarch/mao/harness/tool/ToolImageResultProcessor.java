package cn.etarch.mao.harness.tool;

import cn.etarch.mao.harness.core.ToolAttachment;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Parses read_file image tool results: strip data_uri for persistence, build metadata.
 */
@Slf4j
public final class ToolImageResultProcessor {

    public static final String VISION_ERROR_TEMPLATE =
            "错误：无法读取图片（当前模型不支持图片输入）。请告知用户切换到支持视觉的模型后重试。文件：%s";

    private ToolImageResultProcessor() {
    }

    public record ProcessedToolResult(
            String sanitizedContent,
            ToolAttachment attachment,
            String metadataJson,
            Map<String, Object> preview
    ) {}

    public static ProcessedToolResult process(String rawResult, boolean supportsVision, ObjectMapper objectMapper) {
        if (rawResult == null || rawResult.isBlank()) {
            return new ProcessedToolResult(rawResult, null, null, null);
        }
        try {
            JsonNode node = objectMapper.readTree(rawResult);
            if (!isImageResult(node)) {
                return new ProcessedToolResult(rawResult, null, null, null);
            }

            String path = node.path("path").asText("");
            String mime = node.path("mime").asText("");
            String dataUri = node.has("data_uri") ? node.get("data_uri").asText(null) : null;

            if (!supportsVision) {
                String errorContent = String.format(VISION_ERROR_TEMPLATE, path.isBlank() ? "未知文件" : path);
                String errorJson = objectMapper.writeValueAsString(Map.of(
                        "content", errorContent,
                        "total_lines", 0
                ));
                return new ProcessedToolResult(errorJson, null, null, null);
            }

            if (dataUri == null || dataUri.isBlank()) {
                return new ProcessedToolResult(rawResult, null, null, null);
            }

            ToolAttachment attachment = ToolAttachment.builder()
                    .mime(mime)
                    .path(path)
                    .dataUri(dataUri)
                    .build();

            ObjectNode stripped = node.deepCopy();
            stripped.remove("data_uri");
            String sanitized = objectMapper.writeValueAsString(stripped);

            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("attachments", java.util.List.of(Map.of(
                    "mime", mime,
                    "path", path,
                    "data_uri", dataUri
            )));
            String metadataJson = objectMapper.writeValueAsString(metadata);

            Map<String, Object> preview = new LinkedHashMap<>();
            preview.put("media_type", "image");
            preview.put("mime", mime);
            preview.put("data_uri", dataUri);

            return new ProcessedToolResult(sanitized, attachment, metadataJson, preview);
        } catch (Exception e) {
            log.warn("Failed to process image tool result", e);
            return new ProcessedToolResult(rawResult, null, null, null);
        }
    }

    public static boolean isImageResult(JsonNode node) {
        return node != null
                && node.isObject()
                && "image".equals(node.path("media_type").asText(null));
    }

    public static boolean isImageResult(String rawResult, ObjectMapper objectMapper) {
        try {
            return isImageResult(objectMapper.readTree(rawResult));
        } catch (Exception e) {
            return false;
        }
    }
}
