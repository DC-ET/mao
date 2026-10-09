import { describe, expect, it } from 'vitest'
import { expandRoundContainingMessage, type MessageRound } from './useMessageRounds'

function round(userId: string, stepId: string): MessageRound {
  const user = { id: userId, role: 'user' as const, content: '问', createdAt: '' }
  const step = { id: stepId, role: 'assistant' as const, content: '中间步骤', createdAt: '' }
  const reply = { id: 'final', role: 'assistant' as const, content: '最终回复', createdAt: '' }
  return {
    userMessage: user,
    collapsedSteps: [step],
    displaySteps: [step],
    finalReply: reply,
    stepCount: 1,
    durationText: '',
    fileChanges: [],
  }
}

describe('expandRoundContainingMessage', () => {
  it('expands the round whose folded step is the located message', () => {
    const expanded: Record<string, boolean> = {}
    const opened = expandRoundContainingMessage([round('u1', 'step-2')], expanded, 'step-2')
    expect(opened).toBe(true)
    expect(expanded.u1).toBe(true)
  })

  it('does not expand when the hit is the final reply', () => {
    const expanded: Record<string, boolean> = {}
    expect(expandRoundContainingMessage([round('u1', 'step-2')], expanded, 'final')).toBe(false)
    expect(expanded.u1).toBeUndefined()
  })
})
