export interface ToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  result?: string
  summary?: string
  status: 'pending' | 'running' | 'success' | 'error'
  isExpanded: boolean
  argsStreaming: boolean
}

export interface FileChange {
  path: string
  type: 'CREATED' | 'MODIFIED'
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
}

export interface TodoItem {
  id: number
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ContextWindowInfo {
  estimated: number
  actual: number
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
  preview?: string
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
