import type { ContentPart } from '../../domain/types.js';

/** 图片 part 在预览中的占位文本，避免纯图片消息在通知里变成空白。 */
const IMAGE_PLACEHOLDER = '[图片]';

/**
 * 定时任务触发器包装（契约见 schedule/scheduled-task.service.ts 的 buildScheduledPrompt）：
 * 通知里展示这层模板文字没有信息量，剥掉后只留分隔线之后的真实任务内容。
 */
const SCHEDULED_TRIGGER_PREFIX = '[系统提示：本消息由定时任务';
const SCHEDULED_TRIGGER_SEPARATOR = '\n---\n';

/**
 * 从 message.content 提取用于通知展示的纯文本预览。
 *
 * 会话消息内容有两种落库形态：纯文本字符串，或 ContentPart 数组（多模态消息，
 * 库内以 JSON 字符串存储）。本函数对两种形态都做兼容，解析失败一律降级为原字符串，
 * 保证通知不因脏数据发不出去。
 */
export function userMessagePreviewOf(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') {
    const parsed = parsePartsJson(content);
    return normalizePreview(parsed == null ? content : partsToText(parsed));
  }
  if (Array.isArray(content)) return normalizePreview(partsToText(content));
  return '';
}

function normalizePreview(text: string): string {
  // 统一去掉首尾空白，并剥离定时任务触发器包装（只留真实任务内容）。
  return stripScheduledTrigger(text).trim();
}

function stripScheduledTrigger(text: string): string {
  if (!text.startsWith(SCHEDULED_TRIGGER_PREFIX)) return text;
  const separatorAt = text.indexOf(SCHEDULED_TRIGGER_SEPARATOR);
  return separatorAt < 0 ? text : text.slice(separatorAt + SCHEDULED_TRIGGER_SEPARATOR.length);
}

/** 仅当字符串确实是 ContentPart 数组的 JSON 时才解析，普通文本（含以 [ 开头的提问文本）原样保留。 */
function parsePartsJson(content: string): unknown[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function partsToText(parts: unknown[]): string {
  const texts: string[] = [];
  let imageCount = 0;
  for (const part of parts) {
    if (part == null || typeof part !== 'object') continue;
    const map = part as Partial<ContentPart> & Record<string, unknown>;
    if (map.type === 'text' && map.text != null) {
      texts.push(String(map.text));
    } else if (map.type === 'image_url') {
      imageCount++;
    }
  }
  if (imageCount > 0) texts.push(`${IMAGE_PLACEHOLDER}×${imageCount}`);
  return texts.join('\n').trim();
}
