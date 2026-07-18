export interface ToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  result?: string
  summary?: string
  preview?: {
    media_type?: string
    mime?: string
    data_uri?: string
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
