import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'

export type TaskPhase = 'IDLE' | 'RUNNING' | 'WAITING_USER' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED'

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
  running: boolean
}

function normalizeId(id: any): string {
  return id != null ? String(id) : ''
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)

  const activeSession = computed(() =>
    sessions.value.find(s => String(s.id) === String(activeSessionId.value)) || null
  )

  function sessionsByAgent(agentId: string) {
    return sessions.value.filter(s => s.agentId === agentId)
  }

  async function fetchSessions(silent = false) {
    if (!silent) loading.value = true
    try {
      const { data } = await api.get('/sessions')
      const incoming: Session[] = (data || []).map((s: any) => ({ ...s, id: normalizeId(s.id) }))
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
    } finally {
      loading.value = false
    }
  }

  async function fetchSession(id: string) {
    try {
      const { data } = await api.get(`/sessions/${id}`)
      if (data) {
        updateSession(id, { ...data, id: normalizeId(data.id) })
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

  async function deleteSession(id: string) {
    try {
      await api.delete(`/sessions/${id}`)
      sessions.value = sessions.value.filter(s => String(s.id) !== String(id))
      if (activeSessionId.value === String(id)) {
        activeSessionId.value = null
      }
    } catch {
      // ignore
    }
  }

  return {
    sessions,
    activeSessionId,
    loading,
    activeSession,
    sessionsByAgent,
    fetchSessions,
    fetchSession,
    createSession,
    setActiveSession,
    updateSession,
    updateSessionPhase,
    deleteSession
  }
})
