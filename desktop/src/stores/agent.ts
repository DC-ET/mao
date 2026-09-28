import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'

export interface Agent {
  id: string
  name: string
  avatarUrl?: string | null
  description: string
  executionMode: string
  isDefault?: boolean
  enabled?: boolean
}

export const useAgentStore = defineStore('agent', () => {
  const agents = ref<Agent[]>([])
  const activeAgent = ref<Agent | null>(null)
  const loading = ref(false)
  const error = ref(false)

  async function fetchAgents() {
    if (!getToken()) {
      agents.value = []
      error.value = false
      return
    }

    loading.value = true
    try {
      const { data } = await api.get('/agents')
      agents.value = (data || []).filter((agent: Agent) => agent.enabled !== false)
      error.value = false
    } catch {
      agents.value = []
      error.value = true
    } finally {
      loading.value = false
    }
  }

  async function fetchAgent(id: string) {
    try {
      const { data } = await api.get(`/agents/${id}`)
      activeAgent.value = data
      return data
    } catch {
      return null
    }
  }

  function getAgentById(id: string) {
    return agents.value.find(a => a.id === id) || null
  }

  return {
    agents,
    activeAgent,
    loading,
    error,
    fetchAgents,
    fetchAgent,
    getAgentById
  }
})
