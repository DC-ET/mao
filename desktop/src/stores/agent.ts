import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'

export interface Agent {
  id: string
  name: string
  description: string
  iconUrl: string
  tags: string[]
  executionMode: string
  modelId?: number
  modelName?: string
}

export const useAgentStore = defineStore('agent', () => {
  const agents = ref<Agent[]>([])
  const activeAgent = ref<Agent | null>(null)
  const loading = ref(false)

  async function fetchAgents() {
    loading.value = true
    try {
      const { data } = await api.get('/agents')
      agents.value = data || []
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
