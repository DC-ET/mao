package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.tool.ImageFileSupport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Loads tool image attachments from persisted message metadata.
 */
@Slf4j
public final class ToolAttachmentLoader {

    private ToolAttachmentLoader() {
    }

    public static void loadFromMetadata(String toolCallId, String metadataJson,
                                        Map<String, ToolAttachment> target, ObjectMapper objectMapper) {
        if (toolCallId == null || metadataJson == null || metadataJson.isBlank() || target == null) {
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(metadataJson);
            JsonNode attachments = root.get("attachments");
            if (attachments == null || !attachments.isArray() || attachments.isEmpty()) {
                return;
            }
            JsonNode first = attachments.get(0);
            String mime = first.path("mime").asText(null);
            String path = first.path("path").asText(null);
            String dataUri = first.path("data_uri").asText(null);
            if (!ImageFileSupport.isImageMime(mime) || dataUri == null || dataUri.isBlank()) {
                return;
            }
            target.put(toolCallId, ToolAttachment.builder()
                    .mime(mime)
                    .path(path)
                    .dataUri(dataUri)
                    .build());
        } catch (Exception e) {
            log.warn("Failed to parse tool attachment metadata for toolCallId={}", toolCallId, e);
        }
    }

    public static Map<String, ToolAttachment> loadAllFromMessages(
            Iterable<cn.etarch.mao.session.entity.Message> messages, ObjectMapper objectMapper) {
        Map<String, ToolAttachment> attachments = new LinkedHashMap<>();
        for (cn.etarch.mao.session.entity.Message msg : messages) {
            if (!"TOOL".equals(msg.getRole()) || msg.getToolCallId() == null) {
                continue;
            }
            loadFromMetadata(msg.getToolCallId(), msg.getMetadata(), attachments, objectMapper);
        }
        return attachments;
    }
}
