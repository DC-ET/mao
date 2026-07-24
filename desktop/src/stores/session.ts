import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ChatMessage, TodoItem, ContextWindowInfo, QueueMessage, FileChange, PendingQuestion } from '../types/chat'
import { appendTextDelta, appendThinkingDelta as appendThinkingDeltaUtil, appendToolCallStart as appendToolCallStartUtil, collectLiveRunningTools, mergeRunningToolsIntoMessages } from '../utils/chatMessage'
import { nowDateTime } from '../utils/datetime'
import { cloudGroupKey } from '../utils/cloud-project'

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
}

export interface SideTaskItem {
  id: number
  title: string
  modelId?: number
  phase: TaskPhase
  createdAt?: string
}

export interface SubagentItem {
  id: number
  title: string
  phase: TaskPhase
  createdAt?: string
  agentType?: string
  taskDescription?: string
}

export interface SessionGroupMeta {
  label: string
  total: number
  hasMore: boolean
}

const DEFAULT_GROUP_PREVIEW = 5
const DEFAULT_GROUP_PAGE_SIZE = 20

function normalizeId(id: any): string {
  return id != null ? String(id) : ''
}

function normalizeSession(s: any): Session {
  return { ...s, id: normalizeId(s.id), agentId: normalizeId(s.agentId) }
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  /** Per-group list metadata from /sessions/groups (and load-more). */
  const groupMeta = ref<Map<string, SessionGroupMeta>>(new Map())
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)
  const loadingMoreGroups = ref<Set<string>>(new Set())

  // Multi-session message cache — keyed by sessionId
  const sessionMessages = ref<Map<string, ChatMessage[]>>(new Map())
  const sessionTodos = ref<Map<string, TodoItem[]>>(new Map())
  const sessionActivities = ref<Map<string, any[]>>(new Map())
  const sessionContextWindow = ref<Map<string, ContextWindowInfo>>(new Map())
  const sessionCompacting = ref<Map<string, boolean>>(new Map())
  const sessionThinking = ref<Map<string, boolean>>(new Map())
  const sessionStreaming = ref<Map<string, boolean>>(new Map())
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
  // Subagent list cache keyed by parentSessionId
  const subagentCache = ref<Map<string, SubagentItem[]>>(new Map())
  /** parent tool_call_id → child session id（并行 delegate 精确绑定） */
  const delegateToolCallBindings = ref<Map<string, number>>(new Map())

  const activeSession = computed(() =>
    sessions.value.find(s => String(s.id) === String(activeSessionId.value)) || null
  )

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

  const activeCompacting = computed(() =>
    sessionCompacting.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeThinking = computed(() =>
    sessionThinking.value.get(activeSessionId.value ?? '') ?? false
  )

  const activeStreaming = computed(() =>
    sessionStreaming.value.get(activeSessionId.value ?? '') ?? false
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

  async function fetchSessions(silent = false) {
    if (!silent) loading.value = true
    try {
      const { data } = await api.get('/sessions/groups', {
        params: { previewLimit: DEFAULT_GROUP_PREVIEW }
      })
      const groups: any[] = data?.groups || []
      const incoming: Session[] = []
      const meta = new Map<string, SessionGroupMeta>()
      for (const g of groups) {
        const key = String(g.key)
        meta.set(key, {
          label: g.label || key,
          total: Number(g.total) || 0,
          hasMore: !!g.hasMore
        })
        for (const s of g.sessions || []) {
          incoming.push(normalizeSession(s))
        }
      }

      // Merge unread from local; refresh resets to group previews (drops prior load-more pages).
      const merged = incoming.map(s => {
        const local = sessions.value.find(ls => String(ls.id) === String(s.id))
        if (!local) return s
        const m = { ...local, ...s }
        m.unread = local.unread
        return m
      })
      sessions.value = merged
      groupMeta.value = meta

      for (const s of merged) {
        if (s.contextTokens && s.contextTokens > 0) {
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
    const offset = sessions.value.filter(s => cloudGroupKey(s) === key).length
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

      const existingIds = new Set(sessions.value.map(s => String(s.id)))
      const appended = items.filter(s => !existingIds.has(String(s.id)))
      if (appended.length > 0) {
        sessions.value = [...sessions.value, ...appended]
      }

      const loadedAfter = sessions.value.filter(s => cloudGroupKey(s) === key).length
      const serverTotal = data?.total
      const nextMeta: SessionGroupMeta = {
        label: meta?.label || key,
        total: serverTotal != null ? Number(serverTotal) : (meta?.total ?? loadedAfter),
        hasMore: !!data?.hasMore
      }
      groupMeta.value.set(key, nextMeta)
      groupMeta.value = new Map(groupMeta.value)
      return appended.length > 0 || !!data?.hasMore
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

  async function fetchSession(id: string) {
    try {
      const { data } = await api.get(`/sessions/${id}`)
      if (data) {
        const local = sessions.value.find(s => String(s.id) === String(id))
        updateSession(id, { ...data, id: normalizeId(data.id), agentId: normalizeId(data.agentId), unread: local?.unread })
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
      sessions.value.unshift(data)
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
  }

  function updateSession(id: string, updates: Partial<Session>) {
    const sid = String(id)
    const idx = sessions.value.findIndex(s => String(s.id) === sid)
    if (idx !== -1) {
      const next = { ...sessions.value[idx], ...updates, id: normalizeId(updates.id ?? sessions.value[idx].id) }
      if (updates.agentId != null) {
        next.agentId = normalizeId(updates.agentId)
      }
      sessions.value[idx] = next
    } else if (updates.executionMode) {
      // Deep-link / loadSession for a session outside the current group preview
      const inserted = normalizeSession({ id: sid, ...updates })
      sessions.value.unshift(inserted)
      const key = cloudGroupKey(inserted)
      if (!groupMeta.value.has(key)) {
        groupMeta.value.set(key, { label: key, total: 1, hasMore: false })
        groupMeta.value = new Map(groupMeta.value)
      }
    }
  }

  function updateSessionPhase(id: string, phase: TaskPhase) {
    sessionPhases.value.set(String(id), phase)
    updateSession(id, {
      phase,
      running: ACTIVE_PHASES.has(phase)
    })
  }

  function getSessionPhase(id: string): TaskPhase | null {
    const sid = String(id)
    const cached = sessionPhases.value.get(sid)
    if (cached) return cached
    const session = sessions.value.find(s => String(s.id) === sid)
    return session?.phase ?? null
  }

  function setSideTasks(parentSessionId: string, tasks: SideTaskItem[]) {
    sideTaskCache.value.set(String(parentSessionId), tasks)
    sideTaskCache.value = new Map(sideTaskCache.value)
  }

  function addSideTask(parentSessionId: string, task: SideTaskItem) {
    const key = String(parentSessionId)
    const list = sideTaskCache.value.get(key) ?? []
    const filtered = list.filter(t => t.id !== task.id)
    sideTaskCache.value.set(key, [task, ...filtered])
    sideTaskCache.value = new Map(sideTaskCache.value)
  }

  function updateSideTaskPhase(sideSessionId: number, phase: TaskPhase) {
    for (const [, list] of sideTaskCache.value) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        item.phase = phase
        sideTaskCache.value = new Map(sideTaskCache.value)
        break
      }
    }
  }

  function updateSideTaskTitle(parentSessionId: string, sideSessionId: number, title: string) {
    const list = sideTaskCache.value.get(String(parentSessionId))
    if (list) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        item.title = title
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
      const existing = sessions.value.find(s => String(s.id) === String(id))
      await api.delete(`/sessions/${id}`)
      sessions.value = sessions.value.filter(s => String(s.id) !== String(id))
      if (existing) {
        bumpGroupMetaForSession(existing, -1)
      }
      if (activeSessionId.value === String(id)) {
        activeSessionId.value = null
      }
      // Clean up cached data
      const sid = String(id)
      sessionMessages.value.delete(sid)
      sessionTodos.value.delete(sid)
      sessionActivities.value.delete(sid)
      sessionContextWindow.value.delete(sid)
      sessionQueueMessages.value.delete(sid)
      sessionFileChanges.value.delete(sid)
      clearMessagePageState(sid)
    } catch {
      // ignore
    }
  }

  async function markAsRead(sessionId: string) {
    const session = sessions.value.find(s => String(s.id) === String(sessionId))
    if (session) {
      session.unread = false
    }
    try {
      await api.put(`/sessions/${sessionId}/read`)
    } catch {
      // Silent fail — next fetchSessions will sync
    }
  }

  // --- Message cache actions ---

  function setMessages(sessionId: string, messages: ChatMessage[]) {
    sessionMessages.value.set(String(sessionId), messages)
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
    if (lastMsg?.role === 'assistant') {
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

  function markMessageComplete(_sessionId: string, _data: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    // Message end — the full assistant message is now persisted server-side
    // Refresh will pick it up via fetchMessages
  }

  function clearMessages(sessionId: string) {
    sessionMessages.value.delete(String(sessionId))
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

  function setCompacting(sessionId: string, compacting: boolean) {
    sessionCompacting.value.set(String(sessionId), compacting)
  }

  function setThinking(sessionId: string, thinking: boolean) {
    sessionThinking.value.set(String(sessionId), thinking)
  }

  function setStreaming(sessionId: string, streaming: boolean) {
    sessionStreaming.value.set(String(sessionId), streaming)
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
    sessions.value = []
    groupMeta.value = new Map()
    loadingMoreGroups.value = new Set()
    activeSessionId.value = null
    loading.value = false
    sessionMessages.value = new Map()
    sessionTodos.value = new Map()
    sessionActivities.value = new Map()
    sessionContextWindow.value = new Map()
    sessionCompacting.value = new Map()
    sessionThinking.value = new Map()
    sessionStreaming.value = new Map()
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
    updateSession,
    updateSessionPhase,
    getSessionPhase,
    setSideTasks,
    addSideTask,
    updateSideTaskPhase,
    updateSideTaskTitle,
    removeSideTask,
    getSideTasks,
    setSubagents,
    addSubagent,
    updateSubagentPhase,
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
    clearTodos,
    // Activity cache
    addActivity,
    // Context window
    setContextWindow,
    // Compaction
    activeCompacting,
    setCompacting,
    // Thinking
    activeThinking,
    setThinking,
    isSessionThinking,
    // Streaming
    activeStreaming,
    setStreaming,
    isSessionStreaming,
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
