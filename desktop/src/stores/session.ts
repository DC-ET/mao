import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ChatMessage, TodoItem, ContextWindowInfo } from '../types/chat'
import { appendTextDelta, appendToolCallStart as appendToolCallStartUtil } from '../utils/chatMessage'

export type TaskPhase = 'IDLE' | 'RUNNING' | 'WAITING_USER' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'CANCELLING'

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
        // Server data is authoritative; only preserve client-only optimistic fields
        return local ? { ...local, ...s } : s
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
        updateSession(id, { ...data, id: normalizeId(data.id), agentId: normalizeId(data.agentId) })
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
      sessionMessages.value.delete(sid)
      sessionTodos.value.delete(sid)
      sessionActivities.value.delete(sid)
      sessionContextWindow.value.delete(sid)
    } catch {
      // ignore
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

  function getMessages(sessionId: string): ChatMessage[] {
    return sessionMessages.value.get(String(sessionId)) ?? []
  }

  function appendDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    sessionStreaming.value.set(sid, true)
    const list = sessionMessages.value.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.role === 'assistant') {
      appendTextDelta(lastMsg, delta)
      // Trigger reactivity
      sessionMessages.value.set(sid, [...list])
    }
  }

  const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_delete', 'task_list'])

  function appendToolCallStart(sessionId: string, data: { tool_call_id: string; tool_name: string; arguments?: string }) {
    if (TASK_TOOL_NAMES.has(data.tool_name)) {
      // 跳过 task 工具，但在末尾 text 段追加换行，保证后续文本不与前文粘连
      const sid = String(sessionId)
      const list = sessionMessages.value.get(sid)
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
    const list = sessionMessages.value.get(sid)
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
      sessionMessages.value.set(sid, [...list])
    }
  }

  function updateToolCallResult(sessionId: string, data: { tool_call_id: string; result: string; status?: string; summary?: string }) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid)
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
      sessionMessages.value.set(sid, [...list])
    }
  }

  function updateToolCallArgs(sessionId: string, data: { tool_call_id: string; arguments: string }) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg.toolCalls) {
      const call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
      if (call) {
        try { call.input = JSON.parse(data.arguments) } catch { call.input = {} }
        sessionMessages.value.set(sid, [...list])
      }
    }
  }

  function markMessageComplete(_sessionId: string, _data: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    // Message end — the full assistant message is now persisted server-side
    // Refresh will pick it up via fetchMessages
  }

  function clearMessages(sessionId: string) {
    sessionMessages.value.delete(String(sessionId))
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
    // Message cache
    setMessages,
    addUserMessage,
    addAssistantMessage,
    getMessages,
    appendDelta,
    appendToolCallStart,
    updateToolCallArgs,
    updateToolCallResult,
    markMessageComplete,
    clearMessages,
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
    decrementPendingApproval
  }
})
