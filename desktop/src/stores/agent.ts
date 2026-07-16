import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'

export interface Agent {
  id: string
  name: string
  description: string
  tags: string[]
  executionMode: string
  isDefault?: boolean
}

export const useAgentStore = defineStore('agent', () => {
  const agents = ref<Agent[]>([])
  const activeAgent = ref<Agent | null>(null)
  const loading = ref(false)

  async function fetchAgents() {
    if (!getToken()) {
      agents.value = []
      return
    }

    loading.value = true
    try {
      const { data } = await api.get('/agents')
      agents.value = data || []
    } catch {
      agents.value = []
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
    fetchAgents,
    fetchAgent,
    getAgentById
  }
})
