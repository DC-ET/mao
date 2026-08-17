import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ChatMessage, TodoItem, ContextWindowInfo, CompactionEvent, QueueMessage, FileChange, PendingQuestion } from '../types/chat'
import { appendTextDelta, appendThinkingDelta as appendThinkingDeltaUtil, appendToolCallStart as appendToolCallStartUtil, collectLiveRunningTools, mergeRunningToolsIntoMessages } from '../utils/chatMessage'
import { nowDateTime } from '../utils/datetime'
import { cloudGroupKey } from '../utils/cloud-project'
import { sortByFocusPriority, sessionToFocusCandidate } from '../utils/focusSort'

export type SessionStatus = 'ACTIVE' | 'ARCHIVED'

export type TaskPhase = 'IDLE' | 'RUNNING' | 'RESUMING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'CANCELLING'

const ACTIVE_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])

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
  isGit?: boolean
  platform?: string
  shell?: string
  osVersion?: string
  contextTokens?: number
  running: boolean
  permissionLevel?: string
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
}

export interface SideTaskItem {
  id: number
  title: string
  modelId?: number
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

const DEFAULT_GROUP_PREVIEW = 5
const DEFAULT_GROUP_PAGE_SIZE = 20

/**
 * 最后查看的会话 ID 持久化 key。
 * activeSessionId 仅存内存，刷新 / 冷启动（安卓 WebView 被回收后重开）后丢失，
 * 而侧栏排序（活跃任务优先 → 置顶 → updated_at）并不等于“最后查看”，
 * 因此用 localStorage 记录最后活跃会话，恢复时优先还原，失效再回退列表首项。
 */
const LAST_SESSION_KEY = 'mao_last_session_id'

function persistLastSession(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id)
    else localStorage.removeItem(LAST_SESSION_KEY)
  } catch {
    // storage 不可用（如 Electron file:// 下不持久化）——内存态仍可用，忽略
  }
}

function normalizeId(id: any): string {
  return id != null ? String(id) : ''
}

function normalizeSession(s: any): Session {
  return { ...s, id: normalizeId(s.id), agentId: normalizeId(s.agentId) }
}

export const useSessionStore = defineStore('session', () => {
  /**
   * 会话实体缓存（唯一真相源）。所有字段变更只进这里。
   * 各列表投影（standard/archived/focus）只存 ID 数组，组件通过 ID 读实体。
   */
  const sessionEntities = ref<Map<string, Session>>(new Map())
  /** 标准模式分组视图投影：ID 顺序 = 服务端分组预览/分页追加顺序 */
  const standardSessionIds = ref<string[]>([])
  /** 已归档区投影 */
  const archivedSessionIds = ref<string[]>([])
  /** 聚焦模式全量 ACTIVE 主会话投影：成员集合 + 后端基础顺序（排序由 focusedSessions computed 动态派生） */
  const focusSessionIds = ref<string[]>([])

  /** 兼容旧读取点：标准模式列表 = 投影 ID → 实体（只读 computed） */
  const sessions = computed<Session[]>(() =>
    standardSessionIds.value
      .map(id => sessionEntities.value.get(id))
      .filter((s): s is Session => !!s)
  )
  /** 已归档列表（只读 computed） */
  const archivedSessions = computed<Session[]>(() =>
    archivedSessionIds.value
      .map(id => sessionEntities.value.get(id))
      .filter((s): s is Session => !!s)
  )
  /** 聚焦模式列表：投影成员 + 动态优先级排序（不手动维护 ID 顺序）。
   *  实时 pending 信号（WebSocket 增量）与服务端 tree* 取并集（max），
   *  保证主会话待审批 / 待回答在事件到达的瞬间即可升到优先级 0（无需等列表刷新）。 */
  const focusedSessions = computed<Session[]>(() => {
    const realtimeApproval = sessionPendingApprovals.value
    const realtimeQuestions = sessionPendingQuestions.value
    return sortByFocusPriority(
      focusSessionIds.value
        .map(id => sessionEntities.value.get(id))
        .filter((s): s is Session => !!s)
        .map(s => ({
          ...sessionToFocusCandidate(s),
          pendingApprovalCount: Math.max(
            s.treePendingApprovalCount ?? s.pendingApprovalCount ?? 0,
            realtimeApproval.get(String(s.id)) ?? 0
          ),
          pendingQuestionCount: Math.max(
            s.treePendingQuestionCount ?? s.pendingQuestionCount ?? 0,
            realtimeQuestions.get(String(s.id))?.length ?? 0
          ),
        }))
    )
      .map(c => sessionEntities.value.get(c.id))
      .filter((s): s is Session => !!s)
  })

  /** Per-group list metadata from /sessions/groups (and load-more). */
  const groupMeta = ref<Map<string, SessionGroupMeta>>(new Map())
  /** 已归档区分组元数据（数量徽标等） */
  const archivedGroupMeta = ref<Map<string, SessionGroupMeta>>(new Map())
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)
  const archivedLoading = ref(false)
  const focusLoading = ref(false)
  const loadingMoreGroups = ref<Set<string>>(new Set())
  /** 归档/恢复进行中的会话 id（防重复点击并发请求） */
  const archivingIds = ref<Set<string>>(new Set())
  /** 已归档区 / 聚焦数据是否已加载过（用于增量刷新与静默重拉判断） */
  const archivedLoaded = ref(false)
  const focusLoaded = ref(false)

  // Multi-session message cache — keyed by sessionId
  const sessionMessages = ref<Map<string, ChatMessage[]>>(new Map())
  const sessionTodos = ref<Map<string, TodoItem[]>>(new Map())
  const sessionActivities = ref<Map<string, any[]>>(new Map())
  const sessionContextWindow = ref<Map<string, ContextWindowInfo>>(new Map())
  const sessionCompactionEvents = ref<Map<string, CompactionEvent[]>>(new Map())
  const sessionCompacting = ref<Map<string, boolean>>(new Map())
  const sessionThinking = ref<Map<string, boolean>>(new Map())
  const sessionStreaming = ref<Map<string, boolean>>(new Map())
  const streamingAssistantMessageIds = new Map<string, string>()
  const sessionLlmRetry = ref<Map<string, LlmRetryInfo>>(new Map())
  const sessionPendingApprovals = ref<Map<string, number>>(new Map())
  const sessionQueueMessages = ref<Map<string, QueueMessage[]>>(new Map())
  const sessionFileChanges = ref<Map<string, FileChange[]>>(new Map())
  const sessionPendingQuestions = ref<Map<string, PendingQuestion[]>>(new Map())
  const sessionExecutionErrors = ref<Map<string, string>>(new Map())
  const sessionMessageHasMore = ref<Map<string, boolean>>(new Map())
  const sessionMessageLoadingOlder = ref<Map<string, boolean>>(new Map())
  const sessionMessageNextBeforeId = ref<Map<string, string | null>>(new Map())
  // Phase cache for sessions not in the main list (e.g. side tasks)
  const sessionPhases = ref<Map<string, TaskPhase>>(new Map())
  // Side task list cache keyed by parentSessionId
  const sideTaskCache = ref<Map<string, SideTaskItem[]>>(new Map())
  /** 用户当前正在查看的边路任务 Tab（sideSessionId），未查看时为 null。由 useCenterTabs 维护。 */
  const viewingSideTaskId = ref<number | null>(null)
  // Subagent list cache keyed by parentSessionId
  const subagentCache = ref<Map<string, SubagentItem[]>>(new Map())
  /** parent tool_call_id → child session id（并行 delegate 精确绑定） */
  const delegateToolCallBindings = ref<Map<string, number>>(new Map())

  const activeSession = computed(() => {
    const id = activeSessionId.value
    if (!id) return null
    // 从实体缓存查找：归档当前会话后实体保留，activeSession 仍有效（聊天面板不受影响）
    return sessionEntities.value.get(id) || null
  })

  const activeMessages = computed(() =>
    sessionMessages.value.get(activeSessionId.value ?? '') ?? []
  )

  const activeTodos = computed(() =>
    sessionTodos.value.get(activeSessionId.value ?? '') ?? []
  )

  const activeActivities = computed(() =>
    sessionActivities.value.get(activeSessionId.value ?? '') ?? []
  )

  const activeContextWindow = computed(() =>
    sessionContextWindow.value.get(activeSessionId.value ?? '') ?? null
  )

  const activeCompactionEvents = computed(() =>
    sessionCompactionEvents.value.get(activeSessionId.value ?? '') ?? []
  )

  const activeCompacting = computed(() =>
    sessionCompacting.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeThinking = computed(() =>
    sessionThinking.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeStreaming = computed(() =>
    sessionStreaming.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeLlmRetry = computed(() =>
    sessionLlmRetry.value.get(activeSessionId.value ?? '') ?? null
  )

  const activeQueueMessages = computed(() =>
    sessionQueueMessages.value.get(activeSessionId.value ?? '') ?? []
  )

  const activeFileChanges = computed(() =>
    sessionFileChanges.value.get(activeSessionId.value ?? '') ?? []
  )

  const activePendingQuestions = computed(() =>
    sessionPendingQuestions.value.get(activeSessionId.value ?? '') ?? []
  )

  const activeExecutionError = computed(() =>
    sessionExecutionErrors.value.get(activeSessionId.value ?? '') ?? null
  )

  const activeMessageHasMore = computed(() =>
    sessionMessageHasMore.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeMessageLoadingOlder = computed(() =>
    sessionMessageLoadingOlder.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeMessageNextBeforeId = computed(() =>
    sessionMessageNextBeforeId.value.get(activeSessionId.value ?? '') ?? null
  )

  function sessionsByAgent(agentId: string) {
    return sessions.value.filter(s => s.agentId === agentId)
  }

  function applyRuntimeStatus(session: Session) {
    const sid = String(session.id)
    const status = session.runtimeStatus
    if (!session.running || !status) {
      setCompacting(sid, false)
      clearLlmRetry(sid)
      return
    }
    setCompacting(sid, Boolean(status.compacting))
    if (status.llmRetry) {
      setLlmRetry(sid, status.llmRetry)
    } else if (status.llmWaiting) {
      setLlmRetry(sid, status.llmWaiting)
    } else {
      clearLlmRetry(sid)
    }
  }

  async function fetchSessions(silent = false) {
    if (!silent) loading.value = true
    try {
      const { data } = await api.get('/sessions/groups', {
        params: { previewLimit: DEFAULT_GROUP_PREVIEW }
      })
      const groups: any[] = data?.groups || []
      const ids: string[] = []
      const meta = new Map<string, SessionGroupMeta>()
      for (const g of groups) {
        const key = String(g.key)
        meta.set(key, {
          label: g.label || key,
          total: Number(g.total) || 0,
          hasMore: !!g.hasMore
        })
        for (const s of g.sessions || []) {
          const normalized = normalizeSession(s)
          // unread 以服务端为准（服务端 DB 是未读持久化权威；本地已读仅在 markAsRead API 成功后清除）
          upsertSessionEntity(normalized)
          applyRuntimeStatus(normalized)
          ids.push(String(normalized.id))
        }
      }
      // 刷新即重置为分组预览（丢弃先前 load-more 追加的页）
      standardSessionIds.value = ids
      groupMeta.value = meta

      for (const id of ids) {
        const s = sessionEntities.value.get(id)
        if (s && s.contextTokens && s.contextTokens > 0) {
          const sid = String(s.id)
          if (!sessionContextWindow.value.has(sid)) {
            sessionContextWindow.value.set(sid, { estimated: s.contextTokens, actual: 0 })
          }
        }
      }
    } finally {
      loading.value = false
    }
  }

  async function loadMoreInGroup(groupKey: string, limit = DEFAULT_GROUP_PAGE_SIZE): Promise<boolean> {
    const key = String(groupKey)
    if (loadingMoreGroups.value.has(key)) return false
    const meta = groupMeta.value.get(key)
    if (meta && !meta.hasMore) return false

    // Capture offset before await for pagination; do not reuse after await for totals.
    const offset = standardSessionIds.value.filter(id => {
      const s = sessionEntities.value.get(id)
      return s && cloudGroupKey(s) === key
    }).length
    loadingMoreGroups.value = new Set(loadingMoreGroups.value).add(key)
    try {
      const { data } = await api.get('/sessions', {
        params: { groupKey: key, offset, limit }
      })
      const items: Session[] = (data?.items || []).map(normalizeSession)
      if (items.length === 0) {
        if (meta) {
          groupMeta.value.set(key, { ...meta, hasMore: false })
          groupMeta.value = new Map(groupMeta.value)
        }
        return false
      }

      const existingIds = new Set(standardSessionIds.value)
      const appended = items.filter(s => !existingIds.has(String(s.id)))
      const appendedIds: string[] = []
      for (const s of appended) {
        upsertSessionEntity(s)
        applyRuntimeStatus(s)
        appendedIds.push(String(s.id))
      }
      if (appendedIds.length > 0) {
        standardSessionIds.value = [...standardSessionIds.value, ...appendedIds]
      }

      const loadedAfter = standardSessionIds.value.filter(id => {
        const s = sessionEntities.value.get(id)
        return s && cloudGroupKey(s) === key
      }).length
      const serverTotal = data?.total
      const nextMeta: SessionGroupMeta = {
        label: meta?.label || key,
        total: serverTotal != null ? Number(serverTotal) : (meta?.total ?? loadedAfter),
        hasMore: !!data?.hasMore
      }
      groupMeta.value.set(key, nextMeta)
      groupMeta.value = new Map(groupMeta.value)
      return appendedIds.length > 0 || !!data?.hasMore
    } finally {
      const next = new Set(loadingMoreGroups.value)
      next.delete(key)
      loadingMoreGroups.value = next
    }
  }

  function getGroupMeta(groupKey: string): SessionGroupMeta | undefined {
    return groupMeta.value.get(String(groupKey))
  }

  function isGroupLoadingMore(groupKey: string): boolean {
    return loadingMoreGroups.value.has(String(groupKey))
  }

  function bumpGroupMetaForSession(session: Session, delta: number) {
    const key = cloudGroupKey(session)
    const existing = groupMeta.value.get(key)
    if (existing) {
      groupMeta.value.set(key, {
        ...existing,
        total: Math.max(0, existing.total + delta)
      })
    } else if (delta > 0) {
      groupMeta.value.set(key, { label: key, total: 1, hasMore: false })
    }
    groupMeta.value = new Map(groupMeta.value)
  }

  // --- 实体 / 投影模型 ---

  /** 唯一原子更新入口：只写实体，不自动加入任何查询投影（避免污染标准分页等）。 */
  function upsertSessionEntity(session: Session) {
    const sid = String(session.id)
    const normalized = normalizeSession(session)
    normalized.id = sid
    if (session.agentId != null) normalized.agentId = normalizeId(session.agentId)
    sessionEntities.value.set(sid, normalized)
    sessionEntities.value = new Map(sessionEntities.value)
  }

  /** 按 id 读取会话实体（不存在返回 undefined）。 */
  function getSessionEntity(id: string): Session | undefined {
    return sessionEntities.value.get(String(id))
  }

  /** 服务端 session_tree_status 事件：更新父任务实体的任务树聚合信号（聚焦模式实时重排）。 */
  function updateSessionTreeSignals(parentSessionId: string, signals: {
    treePendingApprovalCount?: number
    treePendingQuestionCount?: number
    treeUnread?: boolean
    treeRunning?: boolean
    treeFailed?: boolean
  }) {
    const sid = String(parentSessionId)
    const entity = sessionEntities.value.get(sid)
    if (!entity) return
    upsertSessionEntity({
      ...entity,
      ...(signals.treePendingApprovalCount != null ? { treePendingApprovalCount: signals.treePendingApprovalCount } : {}),
      ...(signals.treePendingQuestionCount != null ? { treePendingQuestionCount: signals.treePendingQuestionCount } : {}),
      ...(signals.treeUnread != null ? { treeUnread: signals.treeUnread } : {}),
      ...(signals.treeRunning != null ? { treeRunning: signals.treeRunning } : {}),
      ...(signals.treeFailed != null ? { treeFailed: signals.treeFailed } : {}),
    })
  }

  function isArchiving(id: string): boolean {
    return archivingIds.value.has(String(id))
  }

  /** 归档：API 成功后再移动本地（失败不预移除）；归档当前会话不清空 activeSessionId。 */
  async function archiveSession(id: string) {
    const sid = String(id)
    if (archivingIds.value.has(sid)) return
    archivingIds.value = new Set(archivingIds.value).add(sid)
    try {
      await api.put(`/sessions/${sid}/archive`)
      const entity = sessionEntities.value.get(sid)
      if (entity) {
        upsertSessionEntity({ ...entity, status: 'ARCHIVED' })
        bumpGroupMetaForSession(entity, -1)
      }
      // ACTIVE → ARCHIVED：从标准/聚焦投影移除，加入已归档投影
      standardSessionIds.value = standardSessionIds.value.filter(x => x !== sid)
      focusSessionIds.value = focusSessionIds.value.filter(x => x !== sid)
      if (!archivedSessionIds.value.includes(sid)) {
        archivedSessionIds.value = [sid, ...archivedSessionIds.value]
      }
      // 已归档区已加载过 → 静默刷新以同步服务端顺序与数量
      if (archivedLoaded.value) {
        await fetchArchivedSessions(true)
      }
    } catch {
      // API 失败：本地不动，等待下次拉取同步
    } finally {
      const next = new Set(archivingIds.value)
      next.delete(sid)
      archivingIds.value = next
    }
  }

  /** 恢复归档：API 成功后再移动本地，并静默刷新标准分组接口（服务端排序决定插入位置）。 */
  async function unarchiveSession(id: string) {
    const sid = String(id)
    if (archivingIds.value.has(sid)) return
    archivingIds.value = new Set(archivingIds.value).add(sid)
    try {
      await api.put(`/sessions/${sid}/unarchive`)
      const entity = sessionEntities.value.get(sid)
      if (entity) {
        upsertSessionEntity({ ...entity, status: 'ACTIVE' })
      }
      // ARCHIVED → ACTIVE：从已归档投影移除；focus 已加载则加入聚焦投影
      archivedSessionIds.value = archivedSessionIds.value.filter(x => x !== sid)
      if (focusLoaded.value && !focusSessionIds.value.includes(sid)) {
        focusSessionIds.value = [sid, ...focusSessionIds.value]
      }
      // 恢复后静默刷新标准分组接口（服务端排序 + groupMeta 自动修正）
      await fetchSessions(true)
      if (archivedLoaded.value) {
        await fetchArchivedSessions(true)
      }
    } catch {
      // API 失败：本地不动
    } finally {
      const next = new Set(archivingIds.value)
      next.delete(sid)
      archivingIds.value = next
    }
  }

  /** 已归档区分组列表（status=ARCHIVED）。 */
  async function fetchArchivedSessions(silent = false) {
    if (!silent) archivedLoading.value = true
    try {
      const { data } = await api.get('/sessions/groups', {
        params: { previewLimit: 50, status: 'ARCHIVED' }
      })
      const groups: any[] = data?.groups || []
      const ids: string[] = []
      const meta = new Map<string, SessionGroupMeta>()
      for (const g of groups) {
        const key = String(g.key)
        meta.set(key, {
          label: g.label || key,
          total: Number(g.total) || 0,
          hasMore: !!g.hasMore
        })
        for (const s of g.sessions || []) {
          const normalized = normalizeSession(s)
          upsertSessionEntity(normalized)
          applyRuntimeStatus(normalized)
          ids.push(String(normalized.id))
        }
      }
      archivedSessionIds.value = ids
      archivedGroupMeta.value = meta
      archivedLoaded.value = true
    } finally {
      archivedLoading.value = false
    }
  }

  /** 聚焦模式全量 ACTIVE 主会话（不带 groupKey）。 */
  async function fetchFocusSessions(silent = false) {
    if (!silent) focusLoading.value = true
    try {
      const { data } = await api.get('/sessions', {
        params: { status: 'ACTIVE' }
      })
      const items: Session[] = Array.isArray(data) ? data.map(normalizeSession) : []
      const ids: string[] = []
      for (const s of items) {
        upsertSessionEntity(s)
        applyRuntimeStatus(s)
        ids.push(String(s.id))
      }
      focusSessionIds.value = ids
      focusLoaded.value = true
    } finally {
      focusLoading.value = false
    }
  }

  async function fetchSession(id: string) {
    try {
      const { data } = await api.get(`/sessions/${id}`)
      if (data) {
        const local = sessionEntities.value.get(String(id))
        const normalized = normalizeSession({ ...data, unread: local?.unread ?? data.unread })
        updateSession(id, normalized)
        applyRuntimeStatus(normalized)
        if (data.contextTokens && data.contextTokens > 0) {
          const sid = normalizeId(data.id)
          if (!sessionContextWindow.value.has(sid)) {
            sessionContextWindow.value.set(sid, { estimated: data.contextTokens, actual: 0 })
          }
        }
      }
      return data
    } catch {
      return null
    }
  }

  async function createSession(
    agentId: string,
    executionMode: string,
    workspace?: string,
    environmentInfo?: SessionEnvironmentInfo,
    modelId?: number,
    permissionLevel?: string,
    cloudProjectKey?: string,
    workspaceMode?: string,
    gitCloneUrl?: string,
    gitBranch?: string
  ) {
    const payload: Record<string, unknown> = {
      agentId,
      executionMode,
      modelId: modelId || undefined,
      permissionLevel: permissionLevel || undefined,
      isGit: environmentInfo?.isGit,
      platform: environmentInfo?.platform,
      shell: environmentInfo?.shell,
      osVersion: environmentInfo?.osVersion
    }
    if (executionMode === 'LOCAL') {
      payload.workspace = workspace || undefined
    } else if (executionMode === 'CLOUD') {
      payload.workspaceMode = workspaceMode || 'new'
      if (workspaceMode === 'git' && gitCloneUrl) {
        payload.gitCloneUrl = gitCloneUrl
        if (gitBranch) payload.gitBranch = gitBranch
      } else if (cloudProjectKey) {
        payload.cloudProjectKey = cloudProjectKey
      }
    }
    const { data } = await api.post('/sessions', payload, {
      timeout: workspaceMode === 'git' ? 150_000 : undefined,
    })
    if (data) {
      data.id = normalizeId(data.id)
      data.agentId = normalizeId(data.agentId)
      upsertSessionEntity(data)
      if (!standardSessionIds.value.includes(String(data.id))) {
        standardSessionIds.value = [String(data.id), ...standardSessionIds.value]
      }
      bumpGroupMetaForSession(data, 1)
    }
    return data
  }

  async function fetchCloudProjects(): Promise<CloudProject[]> {
    try {
      const { data } = await api.get('/sessions/cloud-projects')
      return (data || []) as CloudProject[]
    } catch {
      return []
    }
  }

  function setActiveSession(id: string | null) {
    activeSessionId.value = id
    persistLastSession(id)
  }

  /** 读取持久化的最后查看会话 ID（存储不可用时返回 null）。 */
  function getLastSessionId(): string | null {
    try {
      return localStorage.getItem(LAST_SESSION_KEY)
    } catch {
      return null
    }
  }

  /** 清除持久化的最后查看会话 ID（会话已删除/失效时调用）。 */
  function forgetLastSession() {
    persistLastSession(null)
  }

  function updateSession(id: string, updates: Partial<Session>) {
    const sid = String(id)
    const existing = sessionEntities.value.get(sid)
    const next = normalizeSession({ ...(existing ?? { id: sid }), ...updates, id: sid })
    if (updates.agentId != null) {
      next.agentId = normalizeId(updates.agentId)
    }
    upsertSessionEntity(next)
    if (!existing && updates.executionMode && next.status !== 'ARCHIVED') {
      // Deep-link / loadSession for a session outside the current group preview：
      // 写入标准投影头部（原有行为），并登记分组元数据。已归档会话不进 ACTIVE 投影。
      if (!standardSessionIds.value.includes(sid)) {
        standardSessionIds.value = [sid, ...standardSessionIds.value]
      }
      const key = cloudGroupKey(next)
      if (!groupMeta.value.has(key)) {
        groupMeta.value.set(key, { label: key, total: 1, hasMore: false })
        groupMeta.value = new Map(groupMeta.value)
      }
    }
  }

  function updateSessionPhase(id: string, phase: TaskPhase, startedAt?: string) {
    sessionPhases.value.set(String(id), phase)
    updateSession(id, {
      phase,
      running: ACTIVE_PHASES.has(phase),
      ...(startedAt ? { startedAt } : {})
    })
  }

  /** 合并请求期间可能已被 WS 更新的会话快照，避免迟到的 REST 响应覆盖实时 phase。 */
  function updateSessionFromSnapshot(id: string, snapshot: Partial<Session>, phaseAtRequest?: TaskPhase) {
    const sid = String(id)
    const current = sessionEntities.value.get(sid)
    const livePhase = sessionPhases.value.get(sid)
    const phaseChangedWhileFetching = phaseAtRequest !== undefined
      && current?.phase !== undefined
      && current.phase !== phaseAtRequest
    if (livePhase || phaseChangedWhileFetching) {
      const phase = livePhase ?? current!.phase
      updateSession(id, { ...snapshot, phase, running: ACTIVE_PHASES.has(phase) })
      return
    }
    updateSession(id, snapshot)
  }

  function getSessionPhase(id: string): TaskPhase | null {
    const sid = String(id)
    const cached = sessionPhases.value.get(sid)
    if (cached) return cached
    const session = sessions.value.find(s => String(s.id) === sid)
    return session?.phase ?? null
  }

  function setSideTasks(parentSessionId: string, tasks: SideTaskItem[]) {
    // unread / pending 以服务端为准（服务端 DB 是未读权威；本地已读在 markSideTaskRead API 成功后清除）
    sideTaskCache.value.set(String(parentSessionId), tasks)
    sideTaskCache.value = new Map(sideTaskCache.value)
  }

  async function refreshSideTasks(parentSessionId: string) {
    try {
      const { data } = await api.get(`/sessions/${parentSessionId}/side-tasks`)
      const items: SideTaskItem[] = Array.isArray(data)
        ? data.map((st: any) => ({
            id: st.id,
            title: st.title || '任务',
            modelId: st.modelId,
            phase: (st.phase || 'IDLE') as TaskPhase,
            createdAt: st.createdAt,
            updatedAt: st.updatedAt,
            startedAt: st.startedAt,
            unread: st.unread,
            pendingApprovalCount: st.pendingApprovalCount,
            pendingQuestionCount: st.pendingQuestionCount,
          }))
        : []
      setSideTasks(parentSessionId, items)
    } catch {
      // 保留现有缓存，等待下次会话切换或列表刷新同步
    }
  }

  function addSideTask(parentSessionId: string, task: SideTaskItem) {
    const key = String(parentSessionId)
    const list = sideTaskCache.value.get(key) ?? []
    const filtered = list.filter(t => t.id !== task.id)
    sideTaskCache.value.set(key, [task, ...filtered])
    sideTaskCache.value = new Map(sideTaskCache.value)
  }

  function updateSideTaskPhase(sideSessionId: number, phase: TaskPhase, startedAt?: string) {
    for (const [, list] of sideTaskCache.value) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        item.phase = phase
        if (startedAt) item.startedAt = startedAt
        sideTaskCache.value = new Map(sideTaskCache.value)
        break
      }
    }
  }

  function updateSideTaskUnread(sideSessionId: number, unread: boolean): string | null {
    for (const [parentSessionId, list] of sideTaskCache.value) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        if (unread && viewingSideTaskId.value === sideSessionId) {
          // 用户正打开着该边路任务 Tab：不计未读，并同步清除后端未读
          void markSideTaskRead(sideSessionId)
        } else {
          item.unread = unread
        }
        sideTaskCache.value = new Map(sideTaskCache.value)
        return parentSessionId
      }
    }
    return null
  }

  /** 用户切换查看的边路任务（由 useCenterTabs 在 Tab 激活时维护）。 */
  function setViewingSideTask(sideSessionId: number | null) {
    viewingSideTaskId.value = sideSessionId
  }

  /** 按边路任务独立标记已读：仅在实际打开该边路任务 Tab 时调用。
   *  先同步后端已读，成功后再清除本地未读，避免后端 read 失败/竞态导致圆点看似清除、刷新后又复活。 */
  async function markSideTaskRead(sideSessionId: number) {
    try {
      await api.put(`/sessions/${sideSessionId}/read`)
    } catch {
      // 失败保留本地未读，下次打开 Tab 时重试
      return
    }
    for (const [, list] of sideTaskCache.value) {
      const idx = list.findIndex(t => t.id === sideSessionId)
      if (idx === -1) continue
      if (list[idx].unread) {
        list[idx].unread = false
        sideTaskCache.value = new Map(sideTaskCache.value)
      }
      break
    }
  }

  function updateSideTaskTitle(parentSessionId: string, sideSessionId: number, title: string, modelId?: number) {
    const list = sideTaskCache.value.get(String(parentSessionId))
    if (list) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        item.title = title
        if (modelId != null) item.modelId = modelId
        sideTaskCache.value = new Map(sideTaskCache.value)
      }
    }
  }

  function removeSideTask(parentSessionId: string, sideSessionId: number) {
    const key = String(parentSessionId)
    const list = sideTaskCache.value.get(key)
    if (list) {
      sideTaskCache.value.set(key, list.filter(t => t.id !== sideSessionId))
      sideTaskCache.value = new Map(sideTaskCache.value)
    }
  }

  function getSideTasks(parentSessionId: string): SideTaskItem[] {
    return sideTaskCache.value.get(String(parentSessionId)) ?? []
  }

  function setSubagents(parentSessionId: string, tasks: SubagentItem[]) {
    subagentCache.value.set(String(parentSessionId), tasks)
    subagentCache.value = new Map(subagentCache.value)
  }

  function addSubagent(parentSessionId: string, task: SubagentItem) {
    const key = String(parentSessionId)
    const list = subagentCache.value.get(key) ?? []
    const filtered = list.filter(t => t.id !== task.id)
    subagentCache.value.set(key, [task, ...filtered])
    subagentCache.value = new Map(subagentCache.value)
  }

  function updateSubagentPhase(childSessionId: number, phase: TaskPhase) {
    for (const [, list] of subagentCache.value) {
      const item = list.find(t => t.id === childSessionId)
      if (item) {
        item.phase = phase
        subagentCache.value = new Map(subagentCache.value)
        break
      }
    }
  }

  /** 合并更新子代理元数据（补拉 /sessions/{id} 后写回缓存）。 */
  function updateSubagentMeta(childSessionId: number, meta: { title?: string; phase?: TaskPhase; modelId?: number }) {
    for (const [, list] of subagentCache.value) {
      const item = list.find(t => t.id === childSessionId)
      if (item) {
        if (meta.title) item.title = meta.title
        if (meta.phase) item.phase = meta.phase
        if (meta.modelId != null) item.modelId = meta.modelId
        subagentCache.value = new Map(subagentCache.value)
        break
      }
    }
  }

  function getSubagents(parentSessionId: string): SubagentItem[] {
    return subagentCache.value.get(String(parentSessionId)) ?? []
  }

  function findSubagentChildId(
    parentSessionId: string,
    opts?: { runningOnly?: boolean; agentType?: string; task?: string }
  ): number | null {
    const list = getSubagents(parentSessionId)
    let candidates = opts?.runningOnly
      ? list.filter(t => t.phase === 'RUNNING' || t.phase === 'WAITING_APPROVAL' || t.phase === 'CANCELLING')
      : list
    if (opts?.agentType) {
      const byType = candidates.filter(t => t.agentType === opts.agentType)
      if (byType.length > 0) candidates = byType
    }
    if (opts?.task != null && opts.task !== '') {
      const byTask = candidates.filter(t => t.taskDescription === opts.task)
      if (byTask.length === 1) return byTask[0].id
      if (byTask.length > 1) candidates = byTask
    }
    return candidates.length === 1 ? candidates[0].id : null
  }

  function bindDelegateToolCall(toolCallId: string, childSessionId: number) {
    if (!toolCallId || !(childSessionId > 0)) return
    delegateToolCallBindings.value.set(String(toolCallId), childSessionId)
    delegateToolCallBindings.value = new Map(delegateToolCallBindings.value)
  }

  function findSubagentByToolCallId(toolCallId: string | undefined | null): number | null {
    if (!toolCallId) return null
    const id = delegateToolCallBindings.value.get(String(toolCallId))
    return id != null && id > 0 ? id : null
  }

  async function renameSession(id: string, title: string) {
    const { data } = await api.patch(`/sessions/${id}`, { title })
    if (data) {
      updateSession(id, { title: data.title, summary: data.summary })
    }
  }

  async function updateSessionModel(id: string, modelId: number) {
    const { data } = await api.patch(`/sessions/${id}`, { modelId })
    if (data) {
      updateSession(id, {
        modelId: data.modelId,
        modelName: data.modelName,
        modelSupportsVision: data.modelSupportsVision
      })
    }
  }

  async function deleteSession(id: string) {
    try {
      const existing = sessionEntities.value.get(String(id))
      await api.delete(`/sessions/${id}`)
      const sid = String(id)
      standardSessionIds.value = standardSessionIds.value.filter(x => x !== sid)
      archivedSessionIds.value = archivedSessionIds.value.filter(x => x !== sid)
      focusSessionIds.value = focusSessionIds.value.filter(x => x !== sid)
      sessionEntities.value.delete(sid)
      sessionEntities.value = new Map(sessionEntities.value)
      if (existing) {
        bumpGroupMetaForSession(existing, -1)
      }
      if (activeSessionId.value === sid) {
        activeSessionId.value = null
      }
      // 若删除的是持久化的最后查看会话，一并清除，避免下次冷启动恢复一个已删除会话
      if (getLastSessionId() === sid) {
        forgetLastSession()
      }
      // Clean up cached data
      sessionMessages.value.delete(sid)
      sessionTodos.value.delete(sid)
      sessionActivities.value.delete(sid)
      sessionContextWindow.value.delete(sid)
      sessionCompactionEvents.value.delete(sid)
      sessionQueueMessages.value.delete(sid)
      sessionFileChanges.value.delete(sid)
      clearMessagePageState(sid)
    } catch {
      // ignore
    }
  }

  async function markAsRead(sessionId: string) {
    // 服务端 DB 是未读持久化权威：API 成功后再清本地；失败保留本地未读（下次拉取同步）
    try {
      await api.put(`/sessions/${sessionId}/read`)
      const entity = sessionEntities.value.get(String(sessionId))
      if (entity && entity.unread) {
        upsertSessionEntity({ ...entity, unread: false })
      }
    } catch {
      // Silent fail — next fetchSessions will sync
    }
  }

  // --- Message cache actions ---

  function setMessages(sessionId: string, messages: ChatMessage[]) {
    const sid = String(sessionId)
    streamingAssistantMessageIds.delete(sid)
    sessionMessages.value.set(sid, messages)
  }

  /**
   * REST 历史覆盖缓存时，保留尚未出现在响应里的尾部消息
   *（队列自动消费刚写入的用户消息、以及正在流式输出的助手气泡）。
   */
  function applyFetchedMessages(
    sessionId: string,
    messages: ChatMessage[],
    options?: { preserveStreamingAssistant?: boolean },
  ) {
    const sid = String(sessionId)
    const local = sessionMessages.value.get(sid) ?? []
    const localIds = new Set(local.map(m => String(m.id)))
    const fetchedIds = new Set(messages.map(m => String(m.id)))
    const newlyFetchedUsers = messages.filter(m => m.role === 'user' && !localIds.has(String(m.id)))
    const tail: ChatMessage[] = []
    for (let i = local.length - 1; i >= 0; i--) {
      const message = local[i]
      if (fetchedIds.has(String(message.id))) break
      const isStreamingAssistant = message.role === 'assistant'
        && streamingAssistantMessageIds.get(sid) === String(message.id)
      const isReplacedOptimisticUser = message.role === 'user'
        && (String(message.id).startsWith('msg_') || String(message.id).startsWith('side_user_'))
        && newlyFetchedUsers.some(fetched => fetched.content === message.content
          && JSON.stringify(fetched.images ?? []) === JSON.stringify(message.images ?? []))
      if (!isReplacedOptimisticUser
        && (message.role !== 'assistant' || (options?.preserveStreamingAssistant && isStreamingAssistant))) {
        tail.unshift(message)
      }
    }
    const prevStreamingId = streamingAssistantMessageIds.get(sid)
    sessionMessages.value.set(sid, tail.length > 0 ? [...messages, ...tail] : messages)
    if (prevStreamingId && tail.some(m => String(m.id) === prevStreamingId)) {
      streamingAssistantMessageIds.set(sid, prevStreamingId)
    } else {
      streamingAssistantMessageIds.delete(sid)
    }
  }

  function prependMessages(sessionId: string, messages: ChatMessage[]) {
    const sid = String(sessionId)
    const existing = sessionMessages.value.get(sid) ?? []
    const existingIds = new Set(existing.map(m => String(m.id)))
    const older = messages.filter(m => !existingIds.has(String(m.id)))
    sessionMessages.value.set(sid, [...older, ...existing])
  }

  function setMessagePageState(sessionId: string, hasMore: boolean, nextBeforeId: string | null) {
    const sid = String(sessionId)
    sessionMessageHasMore.value.set(sid, hasMore)
    sessionMessageNextBeforeId.value.set(sid, nextBeforeId)
  }

  function setLoadingOlderMessages(sessionId: string, loading: boolean) {
    sessionMessageLoadingOlder.value.set(String(sessionId), loading)
  }

  function clearMessagePageState(sessionId: string) {
    const sid = String(sessionId)
    sessionMessageHasMore.value.delete(sid)
    sessionMessageLoadingOlder.value.delete(sid)
    sessionMessageNextBeforeId.value.delete(sid)
  }

  function addUserMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const msgId = String(msg.id)
    if (list.some(m => String(m.id) === msgId)) return
    sessionMessages.value.set(sid, [...list, msg])
  }

  function addAssistantMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list, msg])
  }

  function ensureStreamingAssistantMessage(sessionId: string): ChatMessage {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const lastMsg = list[list.length - 1]
    if (lastMsg?.role === 'assistant' && streamingAssistantMessageIds.get(sid) === String(lastMsg.id)) {
      if (!lastMsg.toolCalls) lastMsg.toolCalls = []
      if (!lastMsg.segments) lastMsg.segments = []
      return lastMsg
    }

    const msg: ChatMessage = {
      id: `msg_${Date.now()}_assistant`,
      role: 'assistant',
      content: '',
      createdAt: nowDateTime(),
      toolCalls: [],
      segments: []
    }
    streamingAssistantMessageIds.set(sid, String(msg.id))
    sessionMessages.value.set(sid, [...list, msg])
    return msg
  }

  /**
   * fetchMessages 用 REST 历史覆盖缓存后，把覆盖前仍在 running 的工具调用合并回去，
   * 避免切换进行中任务时丢失工具右侧转圈状态。
   */
  function mergeLiveRunningTools(sessionId: string, liveMessages: ChatMessage[]) {
    const sid = String(sessionId)
    const running = collectLiveRunningTools(liveMessages)
    if (running.length === 0) return
    const current = sessionMessages.value.get(sid) ?? []
    const merged = mergeRunningToolsIntoMessages(current, running)
    sessionMessages.value.set(sid, merged)
  }

  function getMessages(sessionId: string): ChatMessage[] {
    return sessionMessages.value.get(String(sessionId)) ?? []
  }

  function appendDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    sessionStreaming.value.set(sid, true)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    appendTextDelta(lastMsg, delta)
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list])
  }

  function appendThinkingDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    appendThinkingDeltaUtil(lastMsg, delta)
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list])
  }

  function resetStreamingAssistantMessage(sessionId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const lastMsg = list[list.length - 1]
    if (lastMsg?.role !== 'assistant'
        || streamingAssistantMessageIds.get(sid) !== String(lastMsg.id)) return
    lastMsg.content = ''
    lastMsg.thinkingContent = undefined
    lastMsg.toolCalls = []
    lastMsg.segments = []
    sessionStreaming.value.set(sid, false)
    sessionThinking.value.set(sid, true)
    sessionMessages.value.set(sid, [...list])
  }

  const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_delete', 'task_list'])
  const filteredToolCallIds = new Set<string>()

  function appendToolCallStart(sessionId: string, data: { tool_call_id: string; tool_name: string; arguments?: string }) {
    if (TASK_TOOL_NAMES.has(data.tool_name)) {
      filteredToolCallIds.add(data.tool_call_id)
      // 跳过 task 工具，但在末尾 text 段追加换行，保证后续文本不与前文粘连
      const sid = String(sessionId)
      const lastMsg = ensureStreamingAssistantMessage(sid)
      const list = sessionMessages.value.get(sid) ?? []
      if (lastMsg.segments?.length) {
        const lastSeg = lastMsg.segments[lastMsg.segments.length - 1]
        if (lastSeg.type === 'text') {
          lastSeg.content += '\n\n'
          sessionMessages.value.set(sid, [...list])
        }
      }
      return
    }
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    let input: Record<string, unknown> | undefined
    if (data.arguments) {
      try { input = JSON.parse(data.arguments) } catch { /* ignore */ }
    }
    appendToolCallStartUtil(lastMsg, {
      id: data.tool_call_id,
      name: data.tool_name,
      input,
      status: 'running',
      isExpanded: false,
      argsStreaming: true
    })
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list])
  }

  function updateToolCallResult(sessionId: string, data: {
    tool_call_id: string
    result: string
    status?: string
    summary?: string
    preview?: { media_type?: string; mime?: string; data_uri?: string }
  }) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    if (!lastMsg.toolCalls) lastMsg.toolCalls = []
    let call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
    if (!call) {
      // tool_call_start 被跳过（如 task 工具），不创建新的 tool call
      if (filteredToolCallIds.has(data.tool_call_id)) {
        filteredToolCallIds.delete(data.tool_call_id)
        return
      }
      call = {
        id: data.tool_call_id,
        name: 'tool',
        status: 'running',
        isExpanded: false,
        argsStreaming: false
      }
      lastMsg.toolCalls.push(call)
      if (!lastMsg.segments) lastMsg.segments = []
      lastMsg.segments.push({ type: 'tool', callId: data.tool_call_id })
    }
    call.result = data.result
    call.status = (data.status as any) || 'success'
    call.isExpanded = false
    call.argsStreaming = false
    if (data.summary) call.summary = data.summary
    if (data.preview) call.preview = data.preview
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list])
  }

  function updateToolCallArgs(sessionId: string, data: { tool_call_id: string; arguments: string }) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    if (!lastMsg.toolCalls) lastMsg.toolCalls = []
    const call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
    if (call) {
      try { call.input = JSON.parse(data.arguments) } catch { call.input = {} }
      const list = sessionMessages.value.get(sid) ?? []
      sessionMessages.value.set(sid, [...list])
    }
  }

  function markMessageComplete(sessionId: string, _data: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    streamingAssistantMessageIds.delete(String(sessionId))
    // Message end — the full assistant message is now persisted server-side
    // Refresh will pick it up via fetchMessages
  }

  function clearMessages(sessionId: string) {
    const sid = String(sessionId)
    streamingAssistantMessageIds.delete(sid)
    sessionMessages.value.delete(sid)
  }

  /**
   * 截断指定消息之后的所有消息
   */
  function truncateMessagesAfter(sessionId: string, messageId: string) {
    const messages = sessionMessages.value.get(String(sessionId))
    if (!messages) return

    const targetIndex = messages.findIndex(m => String(m.id) === String(messageId))
    if (targetIndex === -1) return

    // 保留目标消息及其之前的消息
    sessionMessages.value.set(String(sessionId), messages.slice(0, targetIndex + 1))
  }

  /**
   * 更新指定消息的内容
   */
  function updateMessageContent(
    sessionId: string,
    messageId: string,
    newContent: string,
    images?: string[]
  ) {
    const messages = sessionMessages.value.get(String(sessionId))
    if (!messages) return

    const message = messages.find(m => String(m.id) === String(messageId))
    if (message) {
      message.content = newContent
      if (images !== undefined) {
        message.images = images
      }
      message.updatedAt = new Date().toISOString()
      // 触发响应式更新
      sessionMessages.value.set(String(sessionId), [...messages])
    }
  }

  /**
   * 追加消息到会话
   */
  function appendMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list, msg])
  }

  /**
   * 更新最后一条指定角色消息的 ID（用于将临时 ID 替换为数据库真实 ID）
   */
  function updateLastMessageId(sessionId: string, role: 'user' | 'assistant', realId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid)
    if (!list) return

    // 从后往前找最后一条指定角色的消息
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === role && String(list[i].id).startsWith('msg_')) {
        list[i].id = realId
        sessionMessages.value.set(sid, [...list])
        return
      }
    }
  }

  // --- Todo cache actions ---

  function setTodos(sessionId: string, todos: TodoItem[]) {
    sessionTodos.value.set(String(sessionId), todos)
  }

  function getTodos(sessionId: string): TodoItem[] {
    return sessionTodos.value.get(String(sessionId)) ?? []
  }

  function clearTodos(sessionId: string) {
    sessionTodos.value.set(String(sessionId), [])
  }

  // --- Activity cache actions ---

  function addActivity(sessionId: string, activity: any) {
    const sid = String(sessionId)
    const list = sessionActivities.value.get(sid) ?? []
    list.push(activity)
    if (list.length > 100) list.splice(0, list.length - 100)
    sessionActivities.value.set(sid, list)
  }

  function setContextWindow(sessionId: string, info: ContextWindowInfo) {
    sessionContextWindow.value.set(String(sessionId), info)
  }

  function getContextWindow(sessionId: string): ContextWindowInfo | null {
    return sessionContextWindow.value.get(String(sessionId)) ?? null
  }

  function setCompactionEvents(sessionId: string, events: CompactionEvent[]) {
    sessionCompactionEvents.value.set(String(sessionId), events)
  }

  function addCompactionEvent(sessionId: string, event: CompactionEvent) {
    const sid = String(sessionId)
    const list = sessionCompactionEvents.value.get(sid) ?? []
    if (list.some(e => e.id === event.id)) return
    sessionCompactionEvents.value.set(sid, [...list, event])
  }

  function setCompacting(sessionId: string, compacting: boolean) {
    sessionCompacting.value.set(String(sessionId), compacting)
  }

  function setThinking(sessionId: string, thinking: boolean) {
    sessionThinking.value.set(String(sessionId), thinking)
  }

  function setStreaming(sessionId: string, streaming: boolean) {
    sessionStreaming.value.set(String(sessionId), streaming)
  }

  function setLlmRetry(sessionId: string, info: LlmRetryInfo) {
    sessionLlmRetry.value.set(String(sessionId), info)
  }

  function clearLlmRetry(sessionId: string) {
    sessionLlmRetry.value.delete(String(sessionId))
  }

  function clearAllLlmRetry() {
    sessionLlmRetry.value = new Map()
  }

  function getLlmRetry(sessionId: string): LlmRetryInfo | null {
    return sessionLlmRetry.value.get(String(sessionId)) ?? null
  }

  function isSessionCompacting(sessionId: string): boolean {
    return sessionCompacting.value.get(String(sessionId)) ?? false
  }

  function isSessionThinking(sessionId: string): boolean {
    return sessionThinking.value.get(String(sessionId)) ?? false
  }

  function isSessionStreaming(sessionId: string): boolean {
    return sessionStreaming.value.get(String(sessionId)) ?? false
  }

  // --- Pending approval tracking ---

  function incrementPendingApproval(sessionId: string) {
    const sid = String(sessionId)
    const current = sessionPendingApprovals.value.get(sid) ?? 0
    sessionPendingApprovals.value.set(sid, current + 1)
  }

  function decrementPendingApproval(sessionId: string) {
    const sid = String(sessionId)
    const current = sessionPendingApprovals.value.get(sid) ?? 0
    if (current > 1) {
      sessionPendingApprovals.value.set(sid, current - 1)
    } else {
      sessionPendingApprovals.value.delete(sid)
    }
  }

  // --- Queue message actions ---

  function setQueueMessages(sessionId: string, queue: QueueMessage[]) {
    sessionQueueMessages.value.set(String(sessionId), queue)
  }

  function getQueueMessages(sessionId: string): QueueMessage[] {
    return sessionQueueMessages.value.get(String(sessionId)) ?? []
  }

  function clearQueueMessages(sessionId: string) {
    sessionQueueMessages.value.delete(String(sessionId))
  }

  function appendFileChange(sessionId: string, change: FileChange) {
    const key = String(sessionId)
    const changes = sessionFileChanges.value.get(key) || []
    const existing = changes.find(c => c.path === change.path)
    if (existing) {
      existing.linesAdded += change.linesAdded
      existing.linesDeleted += change.linesDeleted
      if (change.type === 'CREATED') existing.type = 'CREATED'
      mergeFileChangeDiff(existing, change)
    } else {
      changes.push({ ...change })
    }
    sessionFileChanges.value.set(key, [...changes])
  }

  function mergeFileChangeDiff(target: FileChange, incoming: FileChange) {
    if (!incoming.diffMode) return
    if (!target.diffMode) {
      target.diffMode = incoming.diffMode
      target.beforeContent = incoming.beforeContent
      target.afterContent = incoming.afterContent
      target.patchContent = incoming.patchContent
      target.patchTruncated = incoming.patchTruncated
      target.diffUnavailableReason = incoming.diffUnavailableReason
      return
    }

    if (target.diffMode === 'SNAPSHOT' && incoming.diffMode === 'SNAPSHOT') {
      target.afterContent = incoming.afterContent
      target.patchTruncated = Boolean(target.patchTruncated || incoming.patchTruncated)
      return
    }

    if (target.diffMode === 'PATCH' || incoming.diffMode === 'PATCH') {
      target.diffMode = 'PATCH'
      target.patchContent = [target.patchContent, incoming.patchContent].filter(Boolean).join('\n')
      target.beforeContent = undefined
      target.afterContent = undefined
      target.patchTruncated = Boolean(target.patchTruncated || incoming.patchTruncated)
      return
    }

    if (incoming.diffMode === 'UNSUPPORTED') {
      target.diffMode = 'UNSUPPORTED'
      target.diffUnavailableReason = incoming.diffUnavailableReason
    }
  }

  function setFileChanges(sessionId: string, changes: FileChange[]) {
    sessionFileChanges.value.set(String(sessionId), changes)
  }

  function clearFileChanges(sessionId: string) {
    sessionFileChanges.value.delete(String(sessionId))
  }

  // --- Pending questions actions ---

  function appendAskQuestion(sessionId: string, question: PendingQuestion) {
    const sid = String(sessionId)
    const list = sessionPendingQuestions.value.get(sid) ?? []
    // Avoid duplicates
    if (!list.some(q => q.requestId === question.requestId)) {
      list.push(question)
      sessionPendingQuestions.value.set(sid, [...list])
    }
  }

  function removeAskQuestion(sessionId: string, requestId: string) {
    const sid = String(sessionId)
    const list = sessionPendingQuestions.value.get(sid)
    if (list) {
      sessionPendingQuestions.value.set(sid, list.filter(q => q.requestId !== requestId))
    }
  }

  function clearAskQuestions(sessionId: string) {
    sessionPendingQuestions.value.delete(String(sessionId))
  }

  function setExecutionError(sessionId: string, message: string) {
    const sid = String(sessionId)
    const next = new Map(sessionExecutionErrors.value)
    next.set(sid, message)
    sessionExecutionErrors.value = next
  }

  function clearExecutionError(sessionId: string) {
    const sid = String(sessionId)
    if (!sessionExecutionErrors.value.has(sid)) return
    const next = new Map(sessionExecutionErrors.value)
    next.delete(sid)
    sessionExecutionErrors.value = next
  }

  function getExecutionError(sessionId: string): string | null {
    return sessionExecutionErrors.value.get(String(sessionId)) ?? null
  }

  function reset() {
    sessionEntities.value = new Map()
    standardSessionIds.value = []
    archivedSessionIds.value = []
    focusSessionIds.value = []
    groupMeta.value = new Map()
    archivedGroupMeta.value = new Map()
    archivedLoaded.value = false
    focusLoaded.value = false
    archivingIds.value = new Set()
    loadingMoreGroups.value = new Set()
    activeSessionId.value = null
    loading.value = false
    archivedLoading.value = false
    focusLoading.value = false
    sessionMessages.value = new Map()
    sessionTodos.value = new Map()
    sessionActivities.value = new Map()
    sessionContextWindow.value = new Map()
    sessionCompactionEvents.value = new Map()
    sessionCompacting.value = new Map()
    sessionThinking.value = new Map()
    sessionStreaming.value = new Map()
    sessionLlmRetry.value = new Map()
    sessionPendingApprovals.value = new Map()
    sessionFileChanges.value = new Map()
    sessionQueueMessages.value = new Map()
    sessionPendingQuestions.value = new Map()
    sessionExecutionErrors.value = new Map()
    sessionMessageHasMore.value = new Map()
    sessionMessageLoadingOlder.value = new Map()
    sessionMessageNextBeforeId.value = new Map()
    sessionPhases.value = new Map()
    sideTaskCache.value = new Map()
    subagentCache.value = new Map()
    delegateToolCallBindings.value = new Map()
  }

  return {
    sessions,
    groupMeta,
    activeSessionId,
    loading,
    loadingMoreGroups,
    activeSession,
    activeMessages,
    activeTodos,
    activeActivities,
    activeContextWindow,
    activeCompactionEvents,
    activeMessageHasMore,
    activeMessageLoadingOlder,
    activeMessageNextBeforeId,
    sessionsByAgent,
    fetchSessions,
    loadMoreInGroup,
    getGroupMeta,
    isGroupLoadingMore,
    fetchSession,
    createSession,
    fetchCloudProjects,
    setActiveSession,
    getLastSessionId,
    forgetLastSession,
    updateSession,
    updateSessionPhase,
    updateSessionFromSnapshot,
    getSessionPhase,
    // 实体 / 投影模型（归档 / 聚焦）
    archivedSessions,
    focusedSessions,
    standardSessionIds,
    archivedSessionIds,
    focusSessionIds,
    archivedLoading,
    focusLoading,
    archivedGroupMeta,
    focusLoaded,
    archivedLoaded,
    isArchiving,
    upsertSessionEntity,
    getSessionEntity,
    updateSessionTreeSignals,
    archiveSession,
    unarchiveSession,
    fetchArchivedSessions,
    fetchFocusSessions,
    setSideTasks,
    refreshSideTasks,
    addSideTask,
    updateSideTaskPhase,
    updateSideTaskUnread,
    setViewingSideTask,
    markSideTaskRead,
    updateSideTaskTitle,
    removeSideTask,
    getSideTasks,
    setSubagents,
    addSubagent,
    updateSubagentPhase,
    updateSubagentMeta,
    getSubagents,
    findSubagentChildId,
    bindDelegateToolCall,
    findSubagentByToolCallId,
    renameSession,
    updateSessionModel,
    deleteSession,
    markAsRead,
    // Message cache
    setMessages,
    applyFetchedMessages,
    prependMessages,
    setMessagePageState,
    setLoadingOlderMessages,
    clearMessagePageState,
    addUserMessage,
    addAssistantMessage,
    ensureStreamingAssistantMessage,
    mergeLiveRunningTools,
    getMessages,
    appendDelta,
    appendThinkingDelta,
    resetStreamingAssistantMessage,
    appendToolCallStart,
    updateToolCallArgs,
    updateToolCallResult,
    markMessageComplete,
    clearMessages,
    truncateMessagesAfter,
    updateMessageContent,
    appendMessage,
    updateLastMessageId,
    // Todo cache
    setTodos,
    getTodos,
    clearTodos,
    // Activity cache
    addActivity,
    // Context window
    setContextWindow,
    getContextWindow,
    // Compaction
    activeCompacting,
    setCompacting,
    isSessionCompacting,
    setCompactionEvents,
    addCompactionEvent,
    getCompactionEvents: (sessionId: string) =>
      sessionCompactionEvents.value.get(String(sessionId)) ?? [],
    // Thinking
    activeThinking,
    setThinking,
    isSessionThinking,
    // Streaming
    activeStreaming,
    setStreaming,
    isSessionStreaming,
    // LLM retry
    activeLlmRetry,
    setLlmRetry,
    clearLlmRetry,
    clearAllLlmRetry,
    getLlmRetry,
    // Pending approvals
    sessionPendingApprovals,
    incrementPendingApproval,
    decrementPendingApproval,
    // Queue messages
    activeQueueMessages,
    setQueueMessages,
    getQueueMessages,
    clearQueueMessages,
    // File changes
    activeFileChanges,
    appendFileChange,
    setFileChanges,
    clearFileChanges,
    // Pending questions
    sessionPendingQuestions,
    activePendingQuestions,
    appendAskQuestion,
    removeAskQuestion,
    clearAskQuestions,
    // Execution errors
    sessionExecutionErrors,
    activeExecutionError,
    setExecutionError,
    clearExecutionError,
    getExecutionError,
    reset
  }
})
