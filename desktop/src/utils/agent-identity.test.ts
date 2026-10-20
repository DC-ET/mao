import { describe, it, expect } from 'vitest'
import { resolveAgentIdentity, UNKNOWN_AGENT_NAME } from './agent-identity'

const docAgent = {
  id: '7',
  name: '文档助手',
  avatarUrl: '/uploads/agents/7.png',
  description: '负责合同与制度问答',
}

describe('resolveAgentIdentity', () => {
  it('activeAgent 命中且 id 一致时优先使用', () => {
    const identity = resolveAgentIdentity({
      agentId: '7',
      fallbackName: '旧名字',
      activeAgent: docAgent,
      agents: [{ id: '7', name: '列表名字' }],
    })
    expect(identity).toEqual({
      id: '7',
      name: '文档助手',
      avatarUrl: '/uploads/agents/7.png',
      description: '负责合同与制度问答',
      resolved: true,
    })
  })

  it('activeAgent 指向另一个 Agent 时必须忽略', () => {
    const identity = resolveAgentIdentity({
      agentId: '7',
      activeAgent: { id: '9', name: '上一个会话的 Agent' },
      agents: [{ id: '7', name: '文档助手' }],
    })
    expect(identity.name).toBe('文档助手')
    expect(identity.resolved).toBe(true)
  })

  it('activeAgent 未命中时回落到 agents 列表', () => {
    const identity = resolveAgentIdentity({
      agentId: '7',
      fallbackName: '会话里的名字',
      agents: [docAgent],
    })
    expect(identity.name).toBe('文档助手')
    expect(identity.avatarUrl).toBe('/uploads/agents/7.png')
    expect(identity.resolved).toBe(true)
  })

  it('全部未命中时用 fallbackName 兜底并标记未解析', () => {
    const identity = resolveAgentIdentity({
      agentId: '8',
      fallbackName: '已停用的助手',
      agents: [],
    })
    expect(identity).toEqual({
      id: '8',
      name: '已停用的助手',
      avatarUrl: null,
      description: null,
      resolved: false,
    })
  })

  it('全部未命中且 fallbackName 为空白时显示未知智能体', () => {
    const identity = resolveAgentIdentity({ agentId: '8', fallbackName: '   ' })
    expect(identity.name).toBe(UNKNOWN_AGENT_NAME)
    expect(identity.resolved).toBe(false)
  })

  it('agentId 为空时不解析身份，仅回填名称（调用方据此不渲染）', () => {
    expect(resolveAgentIdentity({ agentId: '', fallbackName: 'Agent' })).toEqual({
      id: null,
      name: 'Agent',
      avatarUrl: null,
      description: null,
      resolved: false,
    })
    expect(resolveAgentIdentity({ agentId: null }).name).toBe('')
  })

  it('agent 名称与描述统一去首尾空白，描述为空时归一为 null', () => {
    const identity = resolveAgentIdentity({
      agentId: '7',
      activeAgent: { id: '7', name: '  文档助手  ', description: '   ' },
    })
    expect(identity.name).toBe('文档助手')
    expect(identity.description).toBeNull()
  })
})
