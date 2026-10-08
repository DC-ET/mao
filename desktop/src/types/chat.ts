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
  /** 参数尚未组成完整 JSON 时保留的原始流式内容 */
  argumentsText?: string
  /** 审批放行标记（替我审批 / 前置决策 / 规则放行），未经审批放行的调用为空 */
  approvalMark?: {
    mode: 'llm' | 'jev' | 'rule'
    approved: boolean
    reason: string
    /** mode=rule 时命中的放行规则 id */
    ruleId?: number
  }
  /** 后端在工具实现内已截断输出（结果 JSON 顶层 truncated===true），历史回放与实时事件均落到此标志 */
  resultTruncated?: boolean
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

/** 上下文构成清单的单节统计（技术方案 5.2），tokens 为字节估算口径。 */
export interface ContextSectionStat {
  key: string
  label: string
  tokens: number
  count?: number
}

export interface ContextManifest {
  sections: ContextSectionStat[]
  memoryIds: number[]
  estimatedWindowTokens: number | null
}

export interface ContextWindowInfo {
  estimated: number
  actual: number
  maxTokens?: number  // 模型最大窗口限制
  /** 与 buildRequest 同源产出的上下文构成清单；旧事件无此字段时为 undefined */
  manifest?: ContextManifest | null
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
