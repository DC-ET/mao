import { describe, expect, it } from 'vitest'
import { createSubagentModule } from './subagent'

/**
 * findSubagentChildId 用于把 delegate / spawn_subagent 工具卡片绑定到对应的子代理会话
 * （desktop/src/components/chat/ToolCallCard.vue 的 childSessionId computed）。
 *
 * agentType 过滤在「没有匹配项」时必须把候选集清空，而不是保留全部候选：
 * 否则指定 agent_type='coder' 的工具卡片会绑到当前唯一在跑的另一个类型（如 reviewer）
 * 的子代理上，点击「查看子代理过程」打开的是错误的会话。
 */
describe('findSubagentChildId 按 agent_type 精确匹配', () => {
  it('指定 agent_type 但没有匹配子代理时返回 null（不得回退到其它类型）', () => {
    const store = createSubagentModule()
    store.setSubagents('12', [
      { id: 101, title: '审阅代码', phase: 'RUNNING', agentType: 'reviewer', taskDescription: '审阅代码' },
    ])

    const found = store.findSubagentChildId('12', {
      runningOnly: true,
      agentType: 'coder',
      task: '实现登录鉴权',
    })

    expect(found).toBeNull()
  })

  it('指定 agent_type 时只在该类型内匹配（存在匹配项则正常返回）', () => {
    const store = createSubagentModule()
    store.setSubagents('12', [
      { id: 101, title: '审阅代码', phase: 'RUNNING', agentType: 'reviewer', taskDescription: '审阅代码' },
      { id: 102, title: '实现登录', phase: 'RUNNING', agentType: 'coder', taskDescription: '实现登录鉴权' },
    ])

    const found = store.findSubagentChildId('12', {
      runningOnly: true,
      agentType: 'coder',
      task: '实现登录鉴权',
    })

    expect(found).toBe(102)
  })
})
