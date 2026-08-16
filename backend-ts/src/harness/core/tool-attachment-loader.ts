import type { Message } from '../deps.js';
import type { ToolAttachment } from './tool-attachment.js';
import { ImageFileSupport } from '../tool/image-file-support.js';
import { harnessLog } from '../log.js';

export const ToolAttachmentLoader = {
  loadFromMetadata(
    toolCallId: string | null | undefined,
    metadataJson: string | null | undefined,
    target: Map<string, ToolAttachment> | Record<string, ToolAttachment>,
  ): void {
    if (!toolCallId || !metadataJson || metadataJson.trim() === '') return;
    try {
      const root = JSON.parse(metadataJson) as Record<string, unknown>;
      const attachments = root.attachments;
      if (!Array.isArray(attachments) || attachments.length === 0) return;
      const first = attachments[0] as Record<string, unknown>;
      const mime = first.mime as string | undefined;
      const filePath = first.path as string | undefined;
      const dataUri = first.data_uri as string | undefined;
      if (!ImageFileSupport.isImageMime(mime) || !dataUri) return;
      const att: ToolAttachment = { mime, path: filePath, dataUri };
      if (target instanceof Map) target.set(toolCallId, att);
      else (target as Record<string, ToolAttachment>)[toolCallId] = att;
    } catch (e) {
      harnessLog('warn', `Failed to parse tool attachment metadata for toolCallId=${toolCallId}`, e);
    }
  },

  loadAllFromMessages(messages: Iterable<Message>): Record<string, ToolAttachment> {
    const attachments: Record<string, ToolAttachment> = {};
    for (const msg of messages) {
      if (msg.role !== 'TOOL' || !msg.toolCallId) continue;
      this.loadFromMetadata(msg.toolCallId, msg.metadata, attachments);
    }
    return attachments;
  },
};
