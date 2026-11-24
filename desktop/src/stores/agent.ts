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
  /** Agent 默认模型 ID（技术方案 2026-11-24 §8.2）：新建会话未手选模型时的优先回退。 */
  defaultModelId?: number | null
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
      // 新建会话只展示「客户端可见」的 Agent；不带 scope 的全量列表留给管理后台与其他入口
      const { data } = await api.get('/agents', { params: { scope: 'client' } })
      agents.value = ((data || []) as Agent[]).filter((agent) => agent.enabled !== false)
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
    // AgentVO.id 后端是 number，调用方传的是 string：统一按字符串比较，避免永远命中不了
    return agents.value.find(a => String(a.id) === String(id)) || null
  }

  return {
    agents,
    activeAgent,
    loading,
    error,
    fetchAgents,
    fetchAgent,
    getAgentById,
  }
})
