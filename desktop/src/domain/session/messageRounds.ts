import { normalizeMessageRole, type ChatMessage } from '../../types/chat'
import { isActivePhase } from './phase'
import type { TaskPhase } from '../../stores/session'

export interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
}

export function buildMessageRounds(messages: ChatMessage[], phase?: TaskPhase | null, refreshing = false): MessageRound[] {
  if (refreshing || isActivePhase(phase) || messages.length <= 1) return []

  const groups: { user: ChatMessage; assistantMsgs: ChatMessage[] }[] = []
  let currentGroupIndex = -1

  for (const message of messages) {
    if (normalizeMessageRole(message.role) === 'user') {
      groups.push({ user: message, assistantMsgs: [] })
      currentGroupIndex++
    } else if (currentGroupIndex >= 0) {
      groups[currentGroupIndex].assistantMsgs.push(message)
    }
  }

  return groups.map((group) => {
    const lastIndex = group.assistantMsgs.length - 1
    const steps = lastIndex >= 0 ? group.assistantMsgs.slice(0, lastIndex) : []
    const reply = lastIndex >= 0 ? group.assistantMsgs[lastIndex] : null
    return buildRound(group.user, steps, reply)
  })
}

function buildRound(user: ChatMessage, steps: ChatMessage[], reply: ChatMessage | null): MessageRound {
  const stepCount = steps.length
  let durationText = ''

  if (stepCount > 0) {
    const first = steps[0].createdAt
    const last = (reply || steps[steps.length - 1]).createdAt
    if (first && last) {
      const diff = new Date(last).getTime() - new Date(first).getTime()
      if (diff > 0) {
        const seconds = Math.floor(diff / 1000)
        durationText = seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
      }
    }
  }

  return { userMessage: user, collapsedSteps: steps, finalReply: reply, stepCount, durationText }
}

