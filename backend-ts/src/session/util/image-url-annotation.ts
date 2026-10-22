import type { ContentPart } from '../../domain/types.js';

/**
 * 图片 URL 注入行前缀。对用户可见（气泡 / 导出），保持可读；序号与图片 parts 顺序对应。
 *
 * 背景：消息里的图片只走多模态视觉通道（适配器下载后转 base64），Agent 拿不到文件本体。
 * 把 URL 以文本形式注入用户消息正文后，模型需要文件时可自行用 shell（curl/wget/python3）下载。
 * 技术方案：docs/plan/2026-10-22-chat-image-url-injection-technical-design.md
 */
const IMAGE_URL_LINE_PREFIX = '[图片 ';

/** 既有注入行：行首锚定 + 整行锚定，只剥自己生成的格式，不碰用户正文。 */
const IMAGE_URL_LINE_PATTERN = /^\[图片 \d+\] \S+$/gm;

/** 正文与注入行之间的分隔：无正文时不产生前导空行。 */
const TEXT_URL_SEPARATOR = '\n\n';

/**
 * 剥离全部注入行，并收敛行尾多余空行（剥离后正文以单个换行结尾或为空）。
 */
export function stripImageUrlLines(text: string): string {
  return text.replace(IMAGE_URL_LINE_PATTERN, '').replace(/\n+$/, '');
}

/**
 * 先剥离再追加：编辑重发回传已含注入行的正文时结果不变（幂等）。
 * `images` 为空时原样返回 `text`（纯文本消息零变化）。
 */
export function appendImageUrlLines(text: string, images: readonly string[]): string {
  if (images.length === 0) return text;
  const base = stripImageUrlLines(text);
  const lines = images.map((url, index) => `${IMAGE_URL_LINE_PREFIX}${index + 1}] ${url}`).join('\n');
  if (base === '') return lines;
  return `${base}${TEXT_URL_SEPARATOR}${lines}`;
}

/**
 * 统一的用户消息 parts 组装：文本 part 带注入行 + 图片 parts。
 * 纯图片消息也会生成只含注入行的文本 part（否则纯图消息没有 URL 通道）。
 */
export function buildUserContentParts(text: string, images: readonly string[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (images.length > 0) {
    parts.push({ type: 'text', text: appendImageUrlLines(text, images) });
  } else if (text && text.trim() !== '') {
    parts.push({ type: 'text', text });
  }
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } } as ContentPart);
  }
  return parts;
}
