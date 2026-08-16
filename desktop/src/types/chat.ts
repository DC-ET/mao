import type { MessageSearchItem } from '@mao/contracts'

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
  argsStreaming: boolean
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

export interface FileAttachment {
  id: string
  name: string
  originalName?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinkingContent?: string
  createdAt: string
  updatedAt?: string
  files?: FileAttachment[]
  images?: string[]
  toolCalls?: ToolCall[]
  segments?: MessageSegment[]
  durationMs?: number
  fileChanges?: FileChange[]
  metadata?: Record<string, unknown>
}

export interface TodoItem {
  id: number
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ContextWindowInfo {
  estimated: number
  actual: number
  maxTokens?: number  // 模型最大窗口限制
}

export interface CompactionEvent {
  id: string
  triggerMode: 'request_start' | 'mid_loop' | string
  prevBoundaryMsgId: string
  boundaryMsgId: string
  compactedMessageCount: number
  summaryTokens: number
  savedTokens: number
  durationMs: number
  compactModel?: string
  createdAt?: string
}

export interface QueueMessage {
  id: string
  sessionId: string
  content: string
  images?: string[]
  sortOrder: number
  createdAt?: string
}

// --- Ask User Questions types ---

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuestionAnswer {
  question: string
  selectedLabels: string[]
  customInput: string | null
}

export interface PendingQuestion {
  requestId: string
  questions: Question[]
  metadata?: Record<string, unknown>
}

export function normalizeMessageRole(role: string): ChatMessage['role'] {
  const r = (role || '').toLowerCase()
  if (r === 'user' || r === 'assistant' || r === 'system') return r
  return 'assistant'
}

// --- 会话消息搜索 ---
// 契约来自共享包 @mao/contracts；前端历史命名 SessionSearchItem 与后端 MessageSearchItem 结构一致。
export type SessionSearchItem = MessageSearchItem
