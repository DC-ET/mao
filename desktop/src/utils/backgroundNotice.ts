import type { ChatMessage } from '../types/chat'

/** 后台子代理完成通知的 metadata，由后端 persistCompletionNotice 写入 */
export interface BackgroundCompletionMeta {
  childSessionId?: number
  executionId?: number
  status?: string
  agentType?: string | null
}

/** 通知正文超过此长度默认折叠成摘要，避免子代理输出占满主会话时间线 */
export const NOTICE_COLLAPSE_CHARS = 200

/** 折叠态摘要的截断长度 */
export const NOTICE_EXCERPT_CHARS = 120

export function getBackgroundCompletion(message: ChatMessage): BackgroundCompletionMeta | null {
  const node = message.metadata?.backgroundSubagentCompletion
  if (!node || typeof node !== 'object') return null
  return node as BackgroundCompletionMeta
}

/** 失败/取消时保留原因摘要——入口卡片只显示状态，错误信息有诊断价值 */
export function isBackgroundNoticeFailed(status?: string): boolean {
  return status === 'FAILED' || status === 'CANCELLED'
}

export function isNoticeLong(content?: string): boolean {
  return (content ?? '').length > NOTICE_COLLAPSE_CHARS
}

/** 压成一行纯文本摘要。通知正文是后端纯文本拼装的，折叠态不需要 markdown 渲染 */
export function noticeExcerpt(content?: string): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= NOTICE_EXCERPT_CHARS) return text
  return `${text.slice(0, NOTICE_EXCERPT_CHARS)}…`
}
