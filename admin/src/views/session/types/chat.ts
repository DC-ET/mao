export interface ToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  result?: string
  summary?: string
  preview?: {
    media_type?: string
    mime?: string
    /** 旧响应 / 导出仍可能内联 base64；compact 列表已改为按需取，见下方定位字段 */
    data_uri?: string
    path?: string
    /** compact 列表里图片只留定位信息，展开工具卡片时再向附件端点取字节 */
    sessionId?: string
    messageId?: string
    attachmentIndex?: number
  }
  status: 'pending' | 'running' | 'success' | 'error'
  isExpanded: boolean
}

export type FileChangeType = 'CREATED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | string

export interface FileChange {
  path: string
  type: FileChangeType
  linesAdded: number
  linesDeleted: number
  toolCallId?: string
  diffMode?: 'SNAPSHOT' | 'PATCH' | 'UNSUPPORTED'
  beforeContent?: string
  afterContent?: string
  patchContent?: string
  patchTruncated?: boolean
  diffUnavailableReason?: string
}

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; callId: string }
  | { type: 'thinking'; content: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinkingContent?: string
  createdAt: string
  updatedAt?: string
  images?: string[]
  toolCalls?: ToolCall[]
  segments?: MessageSegment[]
  fileChanges?: FileChange[]
}

export function normalizeMessageRole(role: string): ChatMessage['role'] {
  const r = (role || '').toLowerCase()
  if (r === 'user' || r === 'assistant' || r === 'system') return r
  return 'assistant'
}
