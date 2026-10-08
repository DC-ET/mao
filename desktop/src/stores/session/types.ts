import type { WsTaskPhase } from '@mao/contracts'

export type SessionStatus = 'ACTIVE' | 'ARCHIVED'

/** 任务阶段枚举收口至 @mao/contracts（desktop / sdk/embed 单一来源） */
export type TaskPhase = WsTaskPhase

export const ACTIVE_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])

export interface TaskStep {
  id: string
  label: string
  done: boolean
}

export interface SessionEnvironmentInfo {
  isGit?: boolean
  platform?: string
  shell?: string
  osVersion?: string
}

export interface CloudProject {
  name: string
  path: string
  isGit: boolean
}

export interface Session {
  id: string
  agentId: string
  agentName: string
  title: string
  executionMode: 'CLOUD' | 'LOCAL'
  status: SessionStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  messageCount: number
  // Task fields
  phase: TaskPhase
  summary?: string
  elapsedMs: number
  steps?: TaskStep[]
  projectKey?: string
  workspace?: string
  /** 会话来源：web / embed，embed 会话在任务列表归入独立分组 */
  source?: string
  isGit?: boolean
  platform?: string
  shell?: string
  osVersion?: string
  contextTokens?: number
  /** 最近一次请求的构成快照，刷新后随会话详情带回 */
  contextManifest?: import('../../types/chat').ContextManifest | null
  running: boolean
  permissionLevel?: string
  /** 单会话长期记忆注入关闭标志（后端 VO 布尔；true=已关闭注入） */
  memoryInjectionDisabled?: boolean
  unread?: boolean
  // Model fields
  modelId?: number
  modelName?: string
  modelSupportsVision?: boolean
  // Sub-agent fields
  parentSessionId?: string
  sessionType?: 'NORMAL' | 'SUBAGENT' | 'SIDE_TASK'
  // Pending signals (this session only, from server VO)
  pendingApprovalCount?: number
  pendingQuestionCount?: number
  // Task-tree aggregated signals (this session + its side tasks, from server VO)
  treePendingApprovalCount?: number
  treePendingQuestionCount?: number
  treeUnread?: boolean
  treeRunning?: boolean
  treeFailed?: boolean
  runtimeStatus?: SessionRuntimeStatus
}

export interface SessionRuntimeStatus {
  compacting?: {
    type?: string
    messageCount?: number
    estimatedTokens?: number
  }
  llmWaiting?: LlmRetryInfo
  llmRetry?: LlmRetryInfo
  /** FAILED 时持久化的错误信息，刷新后恢复 */
  executionError?: string
}

export interface SideTaskItem {
  id: number
  title: string
  modelId?: number
  /** 直接父会话 id（recursive 平铺列表里区分直接子级与深层后代：父 id = 主会话 id 即直接子级） */
  parentSessionId?: number
  /** 权限级别（占位态从来源边路会话取缺省用） */
  permissionLevel?: string
  phase: TaskPhase
  createdAt?: string
  updatedAt?: string
  startedAt?: string
  /** 边路任务后台完成且父会话未被查看时的未读标记（左侧任务栏青色圆点） */
  unread?: boolean
  /** 边路任务自身待审批 / 待回答计数（服务端 VO，聚焦排序用） */
  pendingApprovalCount?: number
  pendingQuestionCount?: number
}

export interface SubagentItem {
  id: number
  title: string
  phase: TaskPhase
  createdAt?: string
  agentType?: string
  taskDescription?: string
  modelId?: number
}

export interface SessionGroupMeta {
  label: string
  total: number
  hasMore: boolean
  /** 服务端该分组已返回的条数，作为 load-more 的 offset。不等于本地投影长度（深链注入不计入）。 */
  loadedCount?: number
}

/** LLM 等待或可恢复错误重试进度 */
export interface LlmRetryInfo {
  phase?: 'response_headers' | 'stream_data'
  elapsedSeconds?: number
  reason?: string
  statusCode?: number
  attempt?: number
  maxRetries?: number
  delaySeconds?: number
}

export const DEFAULT_GROUP_PREVIEW = 5
export const DEFAULT_GROUP_PAGE_SIZE = 20

/**
 * 最后查看的会话 ID 持久化 key。
 * activeSessionId 仅存内存，刷新 / 冷启动（安卓 WebView 被回收后重开）后丢失，
 * 而侧栏排序（活跃任务优先 → 置顶 → updated_at）并不等于“最后查看”，
 * 因此用 localStorage 记录最后活跃会话，恢复时优先还原，失效再回退列表首项。
 */
export const LAST_SESSION_KEY = 'mao_last_session_id'

export function persistLastSession(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id)
    else localStorage.removeItem(LAST_SESSION_KEY)
  } catch {
    // storage 不可用（如 Electron file:// 下不持久化）——内存态仍可用，忽略
  }
}

export function normalizeId(id: any): string {
  return id != null ? String(id) : ''
}

export function normalizeSession(s: any): Session {
  return { ...s, id: normalizeId(s.id), agentId: normalizeId(s.agentId) }
}
