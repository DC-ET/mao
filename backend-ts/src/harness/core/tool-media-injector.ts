import type { ChatMessage, LlmModelConfig } from '../llm/chat-request.js';
import type { ToolAttachment } from './tool-attachment.js';
import { ImageFileSupport } from '../tool/image-file-support.js';

export const SYNTHETIC_ATTACHMENT_PROMPT = 'Attached media from tool result:';

export class ToolMediaInjector {
  inject(
    messages: ChatMessage[] | null | undefined,
    toolAttachments: Map<string, ToolAttachment> | Record<string, ToolAttachment> | null | undefined,
    modelConfig: LlmModelConfig | null | undefined,
  ): ChatMessage[] | null | undefined {
    if (!messages || messages.length === 0) return messages;
    const supportsVision = modelConfig?.supportsVision === true;
    const map = toolAttachments instanceof Map
      ? toolAttachments
      : new Map(Object.entries(toolAttachments ?? {}));
    if (map.size === 0) return [...messages];

    const injected: ChatMessage[] = [];
    for (const msg of messages) {
      injected.push(msg);
      if (msg.role !== 'tool' || !msg.toolCallId) continue;
      const attachment = map.get(msg.toolCallId);
      if (!attachment || !ImageFileSupport.isImageMime(attachment.mime)) continue;
      if (!supportsVision || !attachment.dataUri) continue;
      injected.push({
        role: 'user',
        content: [
          { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
          { type: 'image_url', imageUrl: { url: attachment.dataUri } },
        ],
      });
    }
    return injected;
  }
}
