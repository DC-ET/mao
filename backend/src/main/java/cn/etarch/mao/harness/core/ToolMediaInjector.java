package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.harness.tool.ImageFileSupport;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Injects synthetic user messages with image attachments after tool results,
 * following the strategy for OpenAI-compatible APIs.
 */
@Component
public class ToolMediaInjector {

    public static final String SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:";

    public List<ChatRequest.Message> inject(List<ChatRequest.Message> messages,
                                            Map<String, ToolAttachment> toolAttachments,
                                            LlmModelConfig modelConfig) {
        if (messages == null || messages.isEmpty()) {
            return messages;
        }
        boolean supportsVision = modelConfig != null && Boolean.TRUE.equals(modelConfig.getSupportsVision());
        if (toolAttachments == null || toolAttachments.isEmpty()) {
            return new ArrayList<>(messages);
        }

        List<ChatRequest.Message> injected = new ArrayList<>(messages.size());
        for (ChatRequest.Message msg : messages) {
            injected.add(msg);
            if (!"tool".equals(msg.getRole()) || msg.getToolCallId() == null) {
                continue;
            }
            ToolAttachment attachment = toolAttachments.get(msg.getToolCallId());
            if (attachment == null || !ImageFileSupport.isImageMime(attachment.getMime())) {
                continue;
            }
            if (!supportsVision || attachment.getDataUri() == null || attachment.getDataUri().isBlank()) {
                continue;
            }
            injected.add(buildSyntheticUserMessage(attachment));
        }
        return injected;
    }

    private ChatRequest.Message buildSyntheticUserMessage(ToolAttachment attachment) {
        List<ChatRequest.ContentPart> parts = new ArrayList<>();
        parts.add(ChatRequest.ContentPart.builder()
                .type("text")
                .text(SYNTHETIC_ATTACHMENT_PROMPT)
                .build());
        parts.add(ChatRequest.ContentPart.builder()
                .type("image_url")
                .imageUrl(ChatRequest.ImageUrl.builder().url(attachment.getDataUri()).build())
                .build());
        return ChatRequest.Message.builder()
                .role("user")
                .content(parts)
                .build();
    }
}
