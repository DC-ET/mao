import type { ToolAttachment } from '../core/tool-attachment.js';
import { harnessLog } from '../log.js';

export const VISION_ERROR_TEMPLATE =
  '错误：无法读取图片（当前模型不支持图片输入）。请告知用户切换到支持视觉的模型后重试。文件：%s';

export interface ProcessedToolResult {
  sanitizedContent: string | null | undefined;
  attachment: ToolAttachment | null;
  metadataJson: string | null;
  preview: Record<string, unknown> | null;
}

export const ToolImageResultProcessor = {
  process(rawResult: string | null | undefined, supportsVision: boolean): ProcessedToolResult {
    if (rawResult == null || rawResult.trim() === '') {
      return { sanitizedContent: rawResult, attachment: null, metadataJson: null, preview: null };
    }
    const trimmed = rawResult.trimStart();
    if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
      return { sanitizedContent: rawResult, attachment: null, metadataJson: null, preview: null };
    }
    try {
      const node = JSON.parse(rawResult) as Record<string, unknown>;
      if (!this.isImageResult(node)) {
        return { sanitizedContent: rawResult, attachment: null, metadataJson: null, preview: null };
      }
      const filePath = String(node.path ?? '');
      const mime = String(node.mime ?? '');
      const dataUri = node.data_uri != null ? String(node.data_uri) : null;

      if (!supportsVision) {
        const errorContent = VISION_ERROR_TEMPLATE.replace('%s', filePath.trim() === '' ? '未知文件' : filePath);
        return {
          sanitizedContent: JSON.stringify({ content: errorContent, total_lines: 0 }),
          attachment: null,
          metadataJson: null,
          preview: null,
        };
      }
      if (dataUri == null || dataUri.trim() === '') {
        return { sanitizedContent: rawResult, attachment: null, metadataJson: null, preview: null };
      }
      const attachment: ToolAttachment = { mime, path: filePath, dataUri };
      const stripped = { ...node };
      delete stripped.data_uri;
      const metadata = {
        attachments: [{ mime, path: filePath, data_uri: dataUri }],
      };
      const preview = { media_type: 'image', mime, data_uri: dataUri };
      return {
        sanitizedContent: JSON.stringify(stripped),
        attachment,
        metadataJson: JSON.stringify(metadata),
        preview,
      };
    } catch (e) {
      harnessLog('warn', 'Failed to process image tool result', e);
      return { sanitizedContent: rawResult, attachment: null, metadataJson: null, preview: null };
    }
  },

  isImageResult(node: unknown): boolean {
    return node != null && typeof node === 'object' && !Array.isArray(node)
      && (node as Record<string, unknown>).media_type === 'image';
  },

  isImageResultString(rawResult: string): boolean {
    try {
      return this.isImageResult(JSON.parse(rawResult));
    } catch {
      return false;
    }
  },
};
