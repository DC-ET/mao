import type { DeliveryRef } from '@mao/contracts'

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
  /**
   * 执行中耗时的起表时刻（epoch ms，tool_call_start 到达客户端时打）：只服务 running 状态的
   * 秒级走表（ToolCallElapsed），工具结束即不再展示。历史回放无此字段，已完成调用一律不显示耗时。
   */
  startedAtMs?: number
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

/**
 * 引用来源条目（回复引用溯源，技术方案 2026-10-12）：来自最终 ASSISTANT 消息的
 * metadata.citations。n 为后端 URL 白名单（registry）序号，数组按 n 升序；
 * 上标与来源区的展示序号 = 数组下标 +1（见 utils/citationMarkers.ts buildCiteMap）。
 */
export interface Citation {
  n: number
  url: string
  title: string
}

/**
 * 发送媒体投递（统一发送媒体方案 2026-11-18 D5/D6；活引用 2026-11-20 §4.1；快照 2026-11-24 D3）：
 * send_image / send_file 工具结果里的 delivery，从本轮工具调用收集后画在该轮回复下方。
 * 形态：url 指向既有 uploads 产物（形态 B，存量）、ref 为工作区活引用（仅存量消息）、
 * ref 为发送时快照 id（新发送默认，消费端拼带鉴权的 send-download）。url 与 ref 二者有其一。
 */
export interface SendDelivery {
  kind: 'image' | 'file'
  /** 形态 B：uploads 绝对地址（存量消息）。ref 形态为 undefined。 */
  url?: string
  /**
   * `workspace`：会话工作区活引用，**仅存量消息**（新发送不再写出）；
   * `send-file`：发送时另存的快照 id，渲染期拼 `/files/send-download?id=…&token=…`。
   */
  ref?: DeliveryRef
  mime?: string
  bytes?: number
  filename: string
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
  /**
   * 流式输出被中止（服务端不落库被中止的轮次）：终态 REST 重拉时这条气泡是
   * 已流出内容的唯一副本，applyFetchedMessages 据此保留它而不是按 REST 覆盖丢弃。
   */
  interrupted?: boolean
  /**
   * 该气泡属于被新 executionId 顶掉的旧执行（部署重启续跑 / 重试 / 插队）。
   *
   * 与 interrupted 的区别：被顶掉的气泡里未落库的内容会由新执行重新产出，REST
   * 历史才是权威版本。终态重拉时不得按「唯一副本」保留，否则它会排在最终回复之后，
   * 被轮次渲染当成 finalReply，把真正的最终回复挤进折叠步骤。
   */
  superseded?: boolean
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
  /** 本次请求估算体积（字节，技术方案 2026-10-22） */
  requestBytes?: number
  /** 生效的体积触发阈值（字节，0 表示关闭） */
  payloadLimitBytes?: number
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

/** 飞书入站排队项（后端 /sessions/:id/inbound-queue 的 items 元素）。 */
export interface FeishuInboundQueueItem {
  id: string
  /** 群聊发送者展示名；私聊为空串（与飞书排队卡片同口径）。 */
  senderLabel: string
  summary: string
  imageCount: number
  fileCount: number
  createdAt?: string | null
  /** 飞书队列内位次（实时值；与排队卡上的入队快照可能不同）。 */
  queuePosition: number
  /** 当前用户能否取消（本人，或发送者未绑定 mao 账号时由 owner 放行）。 */
  cancelable: boolean
}

/** 当前会话执行来源：飞书 / 本地（WS 等）/ 无执行在跑。 */
export type QueueRunningChannel = 'feishu' | 'local' | null

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
export type { MessageSearchGroup, MessageSearchHit, MessageSearchResult } from '@mao/contracts'
