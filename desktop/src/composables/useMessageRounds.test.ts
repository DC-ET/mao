import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '../types/chat'
import { resolveForkCutPoint, toRoundDirectoryRows, useMessageRounds, type MessageRound } from './useMessageRounds'

function message(id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id, role, content: id, createdAt: '2026-09-29 10:00:00' }
}

function round(overrides: Partial<MessageRound> & Pick<MessageRound, 'userMessage'>): MessageRound {
  return {
    collapsedSteps: [],
    displaySteps: [],
    finalReply: null,
    stepCount: 0,
    durationText: '',
    fileChanges: [],
    ...overrides,
  }
}

describe('resolveForkCutPoint', () => {
  const step = message('step-1')
  const reply = message('reply-1')
  const rounds = [
    round({
      userMessage: message('user-1', 'user'),
      collapsedSteps: [step],
      displaySteps: [step],
      finalReply: reply,
    }),
  ]

  it('切点是该轮助手最终回复', () => {
    expect(resolveForkCutPoint(rounds, 'reply-1')).toBe('reply-1')
  })

  it('点到中间步骤时改回该轮最终回复，不用步骤自己的 id', () => {
    expect(resolveForkCutPoint(rounds, 'step-1')).toBe('reply-1')
  })

  it('用户消息和没有最终回复的轮次不能分叉', () => {
    expect(resolveForkCutPoint(rounds, 'user-1')).toBeNull()
    expect(resolveForkCutPoint([
      round({ userMessage: message('user-2', 'user'), collapsedSteps: [message('step-2')] }),
    ], 'step-2')).toBeNull()
    expect(resolveForkCutPoint(rounds, 'missing')).toBeNull()
  })
})

describe('toRoundDirectoryRows', () => {
  it('目录行取自轮次：序号、摘要（剥离内部标记）、步骤与耗时', () => {
    const rows = toRoundDirectoryRows([
      round({
        userMessage: message('user-1', 'user'),
        stepCount: 12,
        durationText: '3分20秒',
      }),
      round({ userMessage: message('user-2', 'user') }),
    ])
    expect(rows.map(r => r.id)).toEqual(['user-1', 'user-2'])
    expect(rows.map(r => r.index)).toEqual([1, 2])
    expect(rows[0].steps).toBe('12 步 · 3分20秒')
    expect(rows[1].steps).toBe('')
    expect(rows[0].summary).toBe('user-1')
  })

  it('摘要剥掉内部标记（${skill}$ → skill，不把标记语法原文露出）', () => {
    const rows = toRoundDirectoryRows([
      round({
        userMessage: {
          id: 'u', role: 'user', createdAt: '2026-09-29 10:00:00',
          content: '${skill}$帮我把这个项目重构一下',
        } as ChatMessage,
      }),
    ])
    expect(rows[0].summary).toBe('skill帮我把这个项目重构一下')
  })

  it('执行中轮不进目录：historyRounds 排除最后一轮，空闲态含刚完成的最后一轮', () => {
    const messages = ref<ChatMessage[]>([
      { id: 'u1', role: 'user', content: '第一轮', createdAt: '2026-09-29 10:00:00' },
      { id: 'a1', role: 'assistant', content: '第一轮回复', createdAt: '2026-09-29 10:01:00' },
      { id: 'u2', role: 'user', content: '第二轮', createdAt: '2026-09-29 10:02:00' },
      { id: 'a2', role: 'assistant', content: '第二轮回复', createdAt: '2026-09-29 10:03:00' },
    ])
    const sending = ref(false)
    const { historyRounds } = useMessageRounds(messages, sending)

    // 空闲态：两轮全在目录里（含刚完成的最后一轮）
    expect(toRoundDirectoryRows(historyRounds.value).map(r => r.id)).toEqual(['u1', 'u2'])

    // 执行中：最后一轮（当前轮就在屏幕底部）不进目录
    sending.value = true
    expect(toRoundDirectoryRows(historyRounds.value).map(r => r.id)).toEqual(['u1'])
  })
})
