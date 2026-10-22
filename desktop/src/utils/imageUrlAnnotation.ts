/**
 * 聊天图片 URL 注入行（技术方案 docs/plan/2026-10-22-chat-image-url-injection-technical-design.md §5.1）
 * 的桌面端剥离工具：与后端 backend-ts/src/session/util/image-url-annotation.ts 同款格式、各自实现
 * （与 citationMarkers.ts 同一约定：展示层语法不进 shared/contracts）。
 *
 * 用途只有一个：乐观用户消息与 REST 回显/WS 广播比对时做归一化。落库文本 part 带注入行，
 * 而乐观消息是用户原始正文，`user_message_saved` 帧丢失走 REST 兜底时只有剥离后才能判为同一条。
 */

/** 既有注入行：行首锚定 + 整行锚定，只剥服务端生成的格式，不碰用户正文。 */
const IMAGE_URL_LINE_PATTERN = /^\[图片 \d+\] \S+$/gm

/**
 * 剥离全部注入行，并收敛行尾多余空行（与后端 stripImageUrlLines 逐字节一致）。
 * 对不含注入行的内容是恒等操作（`replace` 无匹配即原样返回），纯文本消息零影响。
 */
export function stripImageUrlLines(text: string): string {
  return text.replace(IMAGE_URL_LINE_PATTERN, '').replace(/\n+$/, '')
}
