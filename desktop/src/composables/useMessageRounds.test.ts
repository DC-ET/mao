import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types/chat'
import { resolveForkCutPoint, type MessageRound } from './useMessageRounds'

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
