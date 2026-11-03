import { ref } from 'vue'
import { api } from '../api'

/** 关联反查所需的最小 Agent 形态（GET /agents?includeDisabled=true 的行裁剪）。 */
export interface RelatedAgent {
  id: number
  name: string
  enabled: boolean
  defaultModelId: number | null
  skillNames: string[]
  mcpServerIds: number[]
  httpToolIds: number[]
}

/** id 列表容错解析：非法 JSON / 非正整数一律剔除（与后端 parseHttpToolIds 口径一致）。 */
function parseIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
}

/**
 * 「资源 → 引用它的 Agent」反向索引（技术方案 2026-11-03 §4.3）：
 * 拉一次全量 Agent 列表内存聚合，供模型 / MCP / 自定义工具 / Skill 列表的
 * 「关联 Agent」列复用。fail-soft：无 agent:read 权限或请求失败时置空数组，
 * 关联列显 0，不阻塞页面主数据。
 */
export function useAgentRelations() {
  const agents = ref<RelatedAgent[]>([])
  const loading = ref(false)
  let seq = 0

  async function load(): Promise<void> {
    const current = ++seq
    loading.value = true
    try {
      const { data } = await api.get('/agents', { params: { includeDisabled: true } })
      if (current !== seq) return
      agents.value = (Array.isArray(data) ? data : [])
        .map((row: Record<string, unknown>): RelatedAgent => ({
          id: Number(row?.id),
          name: typeof row?.name === 'string' ? row.name : '',
          enabled: row?.enabled !== false,
          defaultModelId: row?.defaultModelId == null ? null : Number(row.defaultModelId),
          skillNames: Array.isArray(row?.skillNames) ? (row.skillNames as string[]) : [],
          mcpServerIds: parseIdList(row?.mcpServerIds),
          httpToolIds: parseIdList(row?.httpToolIds),
        }))
        .filter((agent) => Number.isInteger(agent.id) && agent.id > 0 && agent.name !== '')
    } catch {
      if (current === seq) agents.value = []
    } finally {
      if (current === seq) loading.value = false
    }
  }

  /** 引用指定默认模型的 Agent（AgentListView 之外的模型反查入口）。 */
  function agentsByModel(modelId: number): RelatedAgent[] {
    return agents.value.filter((agent) => agent.defaultModelId === modelId)
  }

  function agentsByMcpServer(serverId: number): RelatedAgent[] {
    return agents.value.filter((agent) => agent.mcpServerIds.includes(serverId))
  }

  function agentsByHttpTool(toolId: number): RelatedAgent[] {
    return agents.value.filter((agent) => agent.httpToolIds.includes(toolId))
  }

  function agentsBySkill(skillName: string): RelatedAgent[] {
    return agents.value.filter((agent) => agent.skillNames.includes(skillName))
  }

  return { agents, loading, load, agentsByModel, agentsByMcpServer, agentsByHttpTool, agentsBySkill }
}
