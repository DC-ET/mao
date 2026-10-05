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

/** 团队共享条目（GET /v1/shared-agents）：管理员背书 + 按当前用户实时计算的依赖自检。 */
export interface SharedAgent {
  agentId: number
  name: string
  description: string | null
  avatarUrl: string | null
  note: string
  sortOrder: number
  missingSkills: string[]
  mcpIssues: string[]
}

export const useAgentStore = defineStore('agent', () => {
  const agents = ref<Agent[]>([])
  const sharedAgents = ref<SharedAgent[]>([])
  const activeAgent = ref<Agent | null>(null)
  const loading = ref(false)
  const error = ref(false)

  async function fetchAgents() {
    if (!getToken()) {
      agents.value = []
      sharedAgents.value = []
      error.value = false
      return
    }

    loading.value = true
    try {
      const [agentsRes, sharedRes] = await Promise.allSettled([
        api.get('/agents'),
        api.get('/shared-agents'),
      ])
      if (agentsRes.status === 'fulfilled') {
        agents.value = ((agentsRes.value.data || []) as Agent[]).filter((agent) => agent.enabled !== false)
        error.value = false
      } else {
        agents.value = []
        error.value = true
      }
      // 共享目录拉取失败不阻塞主列表，仅置空分区
      sharedAgents.value = sharedRes.status === 'fulfilled'
        ? ((sharedRes.value.data || []) as SharedAgent[])
        : []
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
    sharedAgents,
    activeAgent,
    loading,
    error,
    fetchAgents,
    fetchAgent,
    getAgentById
  }
})
