import type { ChatMessage, ChatRequest } from '../llm/chat-request.js';
import { SYNTHETIC_ATTACHMENT_PROMPT } from './tool-media-injector.js';

/** 兜底剥图后替换成的占位文本（保留“这里原本有一张图”的语义）。 */
export const OMITTED_IMAGE_PLACEHOLDER = '[历史图片已省略]';

function isImagePart(part: unknown): boolean {
  if (part == null || typeof part !== 'object') return false;
  const type = (part as Record<string, unknown>).type;
  if (type === 'image_url') return true;
  // 历史里可能存在 camelCase 形态（未经序列化的内部对象）
  return (part as Record<string, unknown>).imageUrl != null && type !== 'text';
}

function isTextPart(part: unknown, text: string): boolean {
  if (part == null || typeof part !== 'object') return false;
  const p = part as Record<string, unknown>;
  return p.type === 'text' && p.text === text;
}

/** ToolMediaInjector 注入的合成附件消息：`[提示文本, 图片]` 两段，整条只有这一张图。 */
function isSyntheticAttachmentMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' || !Array.isArray(message.content)) return false;
  if (message.content.length !== 2) return false;
  return isTextPart(message.content[0], SYNTHETIC_ATTACHMENT_PROMPT)
    && isImagePart(message.content[1]);
}

/**
 * 压缩请求的体积兜底（技术方案 2026-10-22 §6.4）：
 * 把请求里的历史图片替换为文本占位，并删除 ToolMediaInjector 注入的合成附件消息。
 *
 * 正常路径（阈值 = 供应商上限 × 0.8）不会走到这里——默认压缩请求不剥图，
 * 以保证与主请求共享前缀缓存。只有阈值配置错误或单轮体积突增时才兜底剥图。
 */
export function stripImagesForCompaction(request: ChatRequest): ChatRequest {
  const source = request.messages ?? [];
  const messages: ChatMessage[] = [];
  for (const message of source) {
    if (isSyntheticAttachmentMessage(message)) continue;
    if (!Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    const content = message.content.map((part) => {
      if (!isImagePart(part)) return part;
      return { type: 'text' as const, text: OMITTED_IMAGE_PLACEHOLDER };
    });
    messages.push({ ...message, content });
  }
  return { ...request, messages };
}
