import { ref, computed, reactive } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ChatMessage, TodoItem, ContextWindowInfo, QueueMessage } from '../types/chat'
import { TASK_TOOL_NAMES } from '../types/chat'
import { appendTextDelta, appendThinkingDelta as appendThinkingDeltaUtil, appendToolCallStart as appendToolCallStartUtil } from '../utils/chatMessage'

export type TaskPhase = 'IDLE' | 'RUNNING' | 'RESUMING' | 'WAITING_USER' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'CANCELLING'

export interface TaskStep {
  id: string
  label: string
  done: boolean
}

export interface Session {
  id: string
  agentId: string
  agentName: string
  title: string
  executionMode: 'CLOUD' | 'LOCAL'
  status: 'active' | 'completed' | 'error'
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
  contextTokens?: number
  running: boolean
  permissionLevel?: string
  unread?: boolean
}

function normalizeId(id: any): string {
  return id != null ? String(id) : ''
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)

  // Multi-session message cache — keyed by sessionId
  const sessionMessages = reactive(new Map<string, ChatMessage[]>())
  const sessionTodos = reactive(new Map<string, TodoItem[]>())
  const sessionActivities = reactive(new Map<string, any[]>())
  const sessionContextWindow = reactive(new Map<string, ContextWindowInfo>())
  const sessionCompacting = reactive(new Map<string, boolean>())
  const sessionThinking = reactive(new Map<string, boolean>())
  const sessionStreaming = reactive(new Map<string, boolean>())
  const sessionPendingApprovals = reactive(new Map<string, number>())
  const sessionQueueMessages = reactive(new Map<string, QueueMessage[]>())

  const activeSession = computed(() =>
    sessions.value.find(s => String(s.id) === String(activeSessionId.value)) || null
  )

  const activeMessages = computed(() =>
    sessionMessages.get(activeSessionId.value ?? '') ?? []
  )

  const activeTodos = computed(() =>
    sessionTodos.get(activeSessionId.value ?? '') ?? []
  )

  const activeActivities = computed(() =>
    sessionActivities.get(activeSessionId.value ?? '') ?? []
  )

  const activeContextWindow = computed(() =>
    sessionContextWindow.get(activeSessionId.value ?? '') ?? null
  )

  const activeCompacting = computed(() =>
    sessionCompacting.get(activeSessionId.value ?? '') ?? false
  )

  const activeThinking = computed(() =>
    sessionThinking.get(activeSessionId.value ?? '') ?? false
  )

  const activeStreaming = computed(() =>
    sessionStreaming.get(activeSessionId.value ?? '') ?? false
  )

  const activeQueueMessages = computed(() =>
    sessionQueueMessages.get(activeSessionId.value ?? '') ?? []
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
          if (!sessionContextWindow.has(sid)) {
            sessionContextWindow.set(sid, { estimated: s.contextTokens, actual: 0 })
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
          if (!sessionContextWindow.has(sid)) {
            sessionContextWindow.set(sid, { estimated: data.contextTokens, actual: 0 })
          }
        }
      }
      return data
    } catch {
      return null
    }
  }

  async function createSession(agentId: string, executionMode: string, workspace?: string) {
    const { data } = await api.post('/sessions', {
      agentId,
      executionMode,
      workspace: workspace || undefined
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

  const TERMINAL_PHASES = new Set<TaskPhase>(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

  function updateSession(id: string, updates: Partial<Session>) {
    const sid = String(id)
    const idx = sessions.value.findIndex(s => String(s.id) === sid)
    if (idx !== -1) {
      const current = sessions.value[idx]
      const merged = { ...current, ...updates, id: normalizeId(updates.id ?? current.id) }
      // Guard: prevent stale fetchSession data from overwriting a terminal phase.
      // Terminal phases are set by session_status WS events and should not be
      // regressed by fetchSession returning stale API data.
      if (current.phase && TERMINAL_PHASES.has(current.phase) &&
          merged.phase && !TERMINAL_PHASES.has(merged.phase)) {
        merged.phase = current.phase
        merged.running = current.running
      }
      sessions.value[idx] = merged
    }
  }

  function updateSessionPhase(id: string, phase: TaskPhase) {
    updateSession(id, {
      phase,
      running: phase === 'RUNNING' || phase === 'WAITING_APPROVAL'
    })
  }

  async function renameSession(id: string, title: string) {
    const { data } = await api.patch(`/sessions/${id}`, { title })
    if (data) {
      updateSession(id, { title: data.title, summary: data.summary })
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
      sessionMessages.delete(sid)
      sessionTodos.delete(sid)
      sessionActivities.delete(sid)
      sessionContextWindow.delete(sid)
      sessionQueueMessages.delete(sid)
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
    sessionMessages.set(String(sessionId), messages)
  }

  function addUserMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid) ?? []
    sessionMessages.set(sid, [...list, msg])
  }

  function addAssistantMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid) ?? []
    sessionMessages.set(sid, [...list, msg])
  }

  function getMessages(sessionId: string): ChatMessage[] {
    return sessionMessages.get(String(sessionId)) ?? []
  }

  function appendDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    sessionStreaming.set(sid, true)
    const list = sessionMessages.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.role === 'assistant') {
      appendTextDelta(lastMsg, delta)
      // Trigger reactivity
      sessionMessages.set(sid, [...list])
    }
  }

  function appendThinkingDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.role === 'assistant') {
      appendThinkingDeltaUtil(lastMsg, delta)
      sessionMessages.set(sid, [...list])
    }
  }

  function appendToolCallStart(sessionId: string, data: { tool_call_id: string; tool_name: string; arguments?: string }) {
    if (TASK_TOOL_NAMES.has(data.tool_name)) {
      // 跳过 task 工具，但在末尾 text 段追加换行，保证后续文本不与前文粘连
      const sid = String(sessionId)
      const list = sessionMessages.get(sid)
      if (list && list.length > 0) {
        const lastMsg = list[list.length - 1]
        if (lastMsg.role === 'assistant' && lastMsg.segments?.length) {
          const lastSeg = lastMsg.segments[lastMsg.segments.length - 1]
          if (lastSeg.type === 'text') {
            lastSeg.content += '\n\n'
          }
        }
      }
      return
    }
    const sid = String(sessionId)
    const list = sessionMessages.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.role === 'assistant') {
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
      sessionMessages.set(sid, [...list])
    }
  }

  function updateToolCallResult(sessionId: string, data: { tool_call_id: string; result: string; status?: string; summary?: string }) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.toolCalls) {
      const call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
      if (call) {
        call.result = data.result
        call.status = (data.status as any) || 'success'
        call.isExpanded = false
        call.argsStreaming = false
        if (data.summary) call.summary = data.summary
      }
      sessionMessages.set(sid, [...list])
    }
  }

  function updateToolCallArgs(sessionId: string, data: { tool_call_id: string; arguments: string }) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.toolCalls) {
      const call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
      if (call) {
        try { call.input = JSON.parse(data.arguments) } catch { call.input = {} }
        sessionMessages.set(sid, [...list])
      }
    }
  }

  function markMessageComplete(_sessionId: string, _data: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    // Message end — the full assistant message is now persisted server-side
    // Refresh will pick it up via fetchMessages
  }

  function clearMessages(sessionId: string) {
    sessionMessages.delete(String(sessionId))
  }

  /**
   * 截断指定消息之后的所有消息
   */
  function truncateMessagesAfter(sessionId: string, messageId: string) {
    const messages = sessionMessages.get(String(sessionId))
    if (!messages) return

    const targetIndex = messages.findIndex(m => String(m.id) === String(messageId))
    if (targetIndex === -1) return

    // 保留目标消息及其之前的消息
    sessionMessages.set(String(sessionId), messages.slice(0, targetIndex + 1))
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
    const messages = sessionMessages.get(String(sessionId))
    if (!messages) return

    const message = messages.find(m => String(m.id) === String(messageId))
    if (message) {
      message.content = newContent
      if (images !== undefined) {
        message.images = images
      }
      message.updatedAt = new Date().toISOString()
      // 触发响应式更新
      sessionMessages.set(String(sessionId), [...messages])
    }
  }

  /**
   * 追加消息到会话
   */
  function appendMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid) ?? []
    sessionMessages.set(sid, [...list, msg])
  }

  /**
   * 更新最后一条指定角色消息的 ID（用于将临时 ID 替换为数据库真实 ID）
   */
  function updateLastMessageId(sessionId: string, role: 'user' | 'assistant', realId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.get(sid)
    if (!list) return

    // 从后往前找最后一条指定角色的消息
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === role && String(list[i].id).startsWith('msg_')) {
        list[i].id = realId
        sessionMessages.set(sid, [...list])
        return
      }
    }
  }

  // --- Todo cache actions ---

  function setTodos(sessionId: string, todos: TodoItem[]) {
    sessionTodos.set(String(sessionId), todos)
  }

  function clearTodos(sessionId: string) {
    sessionTodos.set(String(sessionId), [])
  }

  // --- Activity cache actions ---

  function addActivity(sessionId: string, activity: any) {
    const sid = String(sessionId)
    const list = sessionActivities.get(sid) ?? []
    list.push(activity)
    if (list.length > 100) list.splice(0, list.length - 100)
    sessionActivities.set(sid, list)
  }

  function setContextWindow(sessionId: string, info: ContextWindowInfo) {
    sessionContextWindow.set(String(sessionId), info)
  }

  function setCompacting(sessionId: string, compacting: boolean) {
    sessionCompacting.set(String(sessionId), compacting)
  }

  function setThinking(sessionId: string, thinking: boolean) {
    sessionThinking.set(String(sessionId), thinking)
  }

  function setStreaming(sessionId: string, streaming: boolean) {
    sessionStreaming.set(String(sessionId), streaming)
  }

  // --- Pending approval tracking ---

  function incrementPendingApproval(sessionId: string) {
    const sid = String(sessionId)
    const current = sessionPendingApprovals.get(sid) ?? 0
    sessionPendingApprovals.set(sid, current + 1)
  }

  function decrementPendingApproval(sessionId: string) {
    const sid = String(sessionId)
    const current = sessionPendingApprovals.get(sid) ?? 0
    if (current > 1) {
      sessionPendingApprovals.set(sid, current - 1)
    } else {
      sessionPendingApprovals.delete(sid)
    }
  }

  // --- Queue message actions ---

  function setQueueMessages(sessionId: string, queue: QueueMessage[]) {
    sessionQueueMessages.set(String(sessionId), queue)
  }

  function clearQueueMessages(sessionId: string) {
    sessionQueueMessages.delete(String(sessionId))
  }

  function reset() {
    sessions.value = []
    activeSessionId.value = null
    loading.value = false
    sessionMessages.clear()
    sessionTodos.clear()
    sessionActivities.clear()
    sessionContextWindow.clear()
    sessionCompacting.clear()
    sessionThinking.clear()
    sessionStreaming.clear()
    sessionPendingApprovals.clear()
    sessionQueueMessages.clear()
  }

  // --- Per-session getters ---

  function isSessionStreaming(sessionId: string): boolean {
    return sessionStreaming.get(String(sessionId)) ?? false
  }

  function isSessionThinking(sessionId: string): boolean {
    return sessionThinking.get(String(sessionId)) ?? false
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
    deleteSession,
    markAsRead,
    // Message cache
    setMessages,
    addUserMessage,
    addAssistantMessage,
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
    isSessionStreaming,
    isSessionThinking,
    // Pending approvals
    sessionPendingApprovals,
    incrementPendingApproval,
    decrementPendingApproval,
    // Queue messages
    activeQueueMessages,
    setQueueMessages,
    clearQueueMessages,
    reset
  }
})
