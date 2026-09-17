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
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role !== 'tool') {
        injected.push(msg);
        i++;
        continue;
      }
      // 连续 tool 结果必须成组保留：网关要求 assistant.tool_calls 之后紧跟全部 tool output，
      // 中间插入 user（含工具图片）会触发 400「No tool output found for tool call」。
      const group: ChatMessage[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        group.push(messages[i]);
        i++;
      }
      injected.push(...group);
      if (!supportsVision) continue;
      for (const toolMsg of group) {
        if (!toolMsg.toolCallId) continue;
        const attachment = map.get(toolMsg.toolCallId);
        if (!attachment || !ImageFileSupport.isImageMime(attachment.mime) || !attachment.dataUri) continue;
        injected.push({
          role: 'user',
          content: [
            { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
            { type: 'image_url', imageUrl: { url: attachment.dataUri } },
          ],
        });
      }
    }
    return injected;
  }
}
