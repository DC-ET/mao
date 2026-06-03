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

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; callId: string }

export interface FileAttachment {
  id: string
  name: string
  originalName?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  files?: FileAttachment[]
  images?: string[]
  toolCalls?: ToolCall[]
  segments?: MessageSegment[]
  durationMs?: number
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

export function normalizeMessageRole(role: string): ChatMessage['role'] {
  const r = (role || '').toLowerCase()
  if (r === 'user' || r === 'assistant' || r === 'system') return r
  return 'assistant'
}
