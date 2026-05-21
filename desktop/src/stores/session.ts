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
  running: boolean
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)

  const activeSession = computed(() =>
    sessions.value.find(s => s.id === activeSessionId.value) || null
  )

  function sessionsByAgent(agentId: string) {
    return sessions.value.filter(s => s.agentId === agentId)
  }

  async function fetchSessions() {
    loading.value = true
    try {
      const { data } = await api.get('/sessions')
      sessions.value = data || []
    } finally {
      loading.value = false
    }
  }

  async function createSession(agentId: string, executionMode: string, workspace?: string) {
    const { data } = await api.post('/sessions', {
      agentId,
      executionMode,
      workspace: workspace || undefined
    })
    if (data) {
      sessions.value.unshift(data)
    }
    return data
  }

  function setActiveSession(id: string | null) {
    activeSessionId.value = id
  }

  function updateSession(id: string, updates: Partial<Session>) {
    const idx = sessions.value.findIndex(s => s.id === id)
    if (idx !== -1) {
      sessions.value[idx] = { ...sessions.value[idx], ...updates }
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
      sessions.value = sessions.value.filter(s => s.id !== id)
      if (activeSessionId.value === id) {
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
    createSession,
    setActiveSession,
    updateSession,
    updateSessionPhase,
    deleteSession
  }
})
