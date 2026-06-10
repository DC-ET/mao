import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ChatMessage, TodoItem, ContextWindowInfo, QueueMessage, FileChange } from '../types/chat'
import { appendTextDelta, appendThinkingDelta as appendThinkingDeltaUtil, appendToolCallStart as appendToolCallStartUtil } from '../utils/chatMessage'

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
}

function normalizeId(id: any): string {
  return id != null ? String(id) : ''
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)

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

  function sessionsByAgent(agentId: string) {
    return sessions.value.filter(s => s.agentId === agentId)
  }

  async function fetchSessions(silent = false) {
    if (!silent) loading.value = true
    try {
      const { data } = await api.get('/sessions')
      const incoming: Session[] = (data || []).map((s: any) => ({ ...s, id: normalizeId(s.id), agentId: normalizeId(s.agentId) }))
      // Merge: preserve local updates (e.g. server-generated title) that
      // arrived after the request was fired but before it resolved.
      const serverMap = new Map(incoming.map(s => [s.id, s]))
      const merged = incoming.map(s => {
        const local = sessions.value.find(ls => String(ls.id) === String(s.id))
        if (!local) return s
        // Server data is authoritative; only preserve client-only optimistic fields
        const m = { ...local, ...s }
        // Never let fetchSessions overwrite local unread state
        // (managed by session_status events and markAsRead)
        m.unread = local.unread
        return m
      })
      // Keep local-only sessions (created client-side, not yet in server list)
      for (const local of sessions.value) {
        if (!serverMap.has(String(local.id))) {
          merged.unshift(local)
        }
      }
      sessions.value = merged
      // Hydrate context window from persisted contextTokens
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

  async function createSession(agentId: string, executionMode: string, workspace?: string, environmentInfo?: SessionEnvironmentInfo, modelId?: number, permissionLevel?: string) {
    const { data } = await api.post('/sessions', {
      agentId,
      executionMode,
      workspace: workspace || undefined,
      modelId: modelId || undefined,
      permissionLevel: permissionLevel || undefined,
      isGit: environmentInfo?.isGit,
      platform: environmentInfo?.platform,
      shell: environmentInfo?.shell,
      osVersion: environmentInfo?.osVersion
    })
    if (data) {
      data.id = normalizeId(data.id)
      data.agentId = normalizeId(data.agentId)
      sessions.value.unshift(data)
    }
    return data
  }

  function setActiveSession(id: string | null) {
    activeSessionId.value = id
  }

  function updateSession(id: string, updates: Partial<Session>) {
    const sid = String(id)
    const idx = sessions.value.findIndex(s => String(s.id) === sid)
    if (idx !== -1) {
      sessions.value[idx] = { ...sessions.value[idx], ...updates, id: normalizeId(updates.id ?? sessions.value[idx].id) }
    }
  }

  function updateSessionPhase(id: string, phase: TaskPhase) {
    updateSession(id, {
      phase,
      running: ACTIVE_PHASES.has(phase)
    })
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
      await api.delete(`/sessions/${id}`)
      sessions.value = sessions.value.filter(s => String(s.id) !== String(id))
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

  function addUserMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
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
      createdAt: new Date().toLocaleString(),
      toolCalls: [],
      segments: []
    }
    sessionMessages.value.set(sid, [...list, msg])
    return msg
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

  function appendToolCallStart(sessionId: string, data: { tool_call_id: string; tool_name: string; arguments?: string }) {
    if (TASK_TOOL_NAMES.has(data.tool_name)) {
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

  function updateToolCallResult(sessionId: string, data: { tool_call_id: string; result: string; status?: string; summary?: string }) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    if (!lastMsg.toolCalls) lastMsg.toolCalls = []
    let call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
    if (!call) {
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
    } else {
      changes.push({ ...change })
    }
    sessionFileChanges.value.set(key, [...changes])
  }

  function setFileChanges(sessionId: string, changes: FileChange[]) {
    sessionFileChanges.value.set(String(sessionId), changes)
  }

  function clearFileChanges(sessionId: string) {
    sessionFileChanges.value.delete(String(sessionId))
  }

  function reset() {
    sessions.value = []
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
  }

  return {
    sessions,
    activeSessionId,
    loading,
    activeSession,
    activeMessages,
    activeTodos,
    activeActivities,
    activeContextWindow,
    sessionsByAgent,
    fetchSessions,
    fetchSession,
    createSession,
    setActiveSession,
    updateSession,
    updateSessionPhase,
    renameSession,
    updateSessionModel,
    deleteSession,
    markAsRead,
    // Message cache
    setMessages,
    addUserMessage,
    addAssistantMessage,
    ensureStreamingAssistantMessage,
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
    // Streaming
    activeStreaming,
    setStreaming,
    // Pending approvals
    sessionPendingApprovals,
    incrementPendingApproval,
    decrementPendingApproval,
    // Queue messages
    activeQueueMessages,
    setQueueMessages,
    clearQueueMessages,
    // File changes
    activeFileChanges,
    appendFileChange,
    setFileChanges,
    clearFileChanges,
    reset
  }
})
