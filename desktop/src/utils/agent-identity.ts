/**
 * 会话 Agent 身份解析：三处只读展示（顶部身份条 / 输入栏徽标 / 右栏分区）共用一套优先级，
 * 避免同一会话在不同位置显示不同 Agent。
 *
 * 优先级：activeAgent（须与 agentId 一致）→ agents 列表 → 会话 agentName 兜底 → 未知。
 */
export interface AgentLike {
  id: string
  name: string
  avatarUrl?: string | null
  description?: string | null
}

export interface AgentIdentity {
  id: string | null
  name: string
  avatarUrl: string | null
  description: string | null
  /** 是否命中真实 Agent 记录（false = 只有名称兜底，界面提示「已停用或不可见」） */
  resolved: boolean
}

export const UNKNOWN_AGENT_NAME = '未知智能体'

function normalizeText(value?: string | null): string {
  return (value ?? '').trim()
}

function toIdentity(agent: AgentLike, fallbackName: string): AgentIdentity {
  return {
    id: String(agent.id),
    name: normalizeText(agent.name) || fallbackName || UNKNOWN_AGENT_NAME,
    avatarUrl: agent.avatarUrl ?? null,
    description: normalizeText(agent.description) || null,
    resolved: true,
  }
}

export function resolveAgentIdentity(input: {
  agentId?: string | null
  fallbackName?: string | null
  activeAgent?: AgentLike | null
  agents?: AgentLike[]
}): AgentIdentity {
  const agentId = normalizeText(input.agentId)
  const fallbackName = normalizeText(input.fallbackName)

  if (!agentId) {
    return { id: null, name: fallbackName, avatarUrl: null, description: null, resolved: false }
  }

  const active = input.activeAgent
  if (active && String(active.id) === agentId) {
    return toIdentity(active, fallbackName)
  }

  const listed = (input.agents ?? []).find(agent => String(agent.id) === agentId)
  if (listed) {
    return toIdentity(listed, fallbackName)
  }

  return {
    id: agentId,
    name: fallbackName || UNKNOWN_AGENT_NAME,
    avatarUrl: null,
    description: null,
    resolved: false,
  }
}
