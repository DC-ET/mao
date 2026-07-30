import { ref, computed, type Ref } from 'vue'
import { normalizeMessageRole, type ChatMessage, type FileChange } from '../types/chat'
import { parseDateTime } from '../utils/datetime'

export interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  displaySteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
  fileChanges: FileChange[]
}

function isToolOnlyMessage(message: ChatMessage): boolean {
  return normalizeMessageRole(message.role) === 'assistant'
    && !message.content?.trim()
    && !message.thinkingContent?.trim()
    && !!message.toolCalls?.length
}

function endsWithToolSegment(message: ChatMessage): boolean {
  if (normalizeMessageRole(message.role) !== 'assistant' || !message.toolCalls?.length) return false
  if (!message.segments?.length) return true
  return message.segments[message.segments.length - 1].type === 'tool'
}

function mergeAdjacentToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []

  for (const message of messages) {
    const previous = result[result.length - 1]
    if (!isToolOnlyMessage(message) || !previous || !endsWithToolSegment(previous)) {
      result.push({
        ...message,
        toolCalls: message.toolCalls?.map(toolCall => ({ ...toolCall })),
        segments: message.segments?.map(segment => ({ ...segment })),
      })
      continue
    }

    const existingIds = new Set((previous.toolCalls || []).map(toolCall => toolCall.id))
    const appendedToolCalls = (message.toolCalls || []).filter(toolCall => !existingIds.has(toolCall.id))
    previous.toolCalls = [...(previous.toolCalls || []), ...appendedToolCalls]
    previous.segments = [
      ...(previous.segments || []),
      ...(message.segments || []).filter(segment =>
        segment.type !== 'tool' || !existingIds.has(segment.callId)
      ),
    ]
    previous.updatedAt = message.updatedAt || message.createdAt
  }

  return result
}

function buildRound(user: ChatMessage, steps: ChatMessage[], reply: ChatMessage | null): MessageRound {
  const stepCount = steps.length
  let durationText = ''
  if (stepCount > 0) {
    const first = steps[0].createdAt
    const last = (reply || steps[steps.length - 1]).createdAt
    if (first && last) {
      const start = parseDateTime(first)
      const end = parseDateTime(last)
      if (start && end) {
        const diff = end.getTime() - start.getTime()
        if (diff > 0) {
          const s = Math.floor(diff / 1000)
          durationText = s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`
        }
      }
    }
  }
  const fileChanges: FileChange[] = [...steps, ...(reply ? [reply] : [])]
    .flatMap(m => m.fileChanges || [])
  return {
    userMessage: user,
    collapsedSteps: steps,
    displaySteps: mergeAdjacentToolMessages(steps),
    finalReply: reply,
    stepCount,
    durationText,
    fileChanges,
  }
}

export function useMessageRounds(messages: Ref<ChatMessage[]>, sending: Ref<boolean>) {
  const roundsExpanded = ref<Record<string, boolean>>({})

  const messageRounds = computed((): MessageRound[] => {
    const msgs = messages.value
    if (msgs.length <= 1) return []

    const groups: { user: ChatMessage; assistantMsgs: ChatMessage[] }[] = []
    let cur = -1
    for (const m of msgs) {
      if (normalizeMessageRole(m.role) === 'user') {
        groups.push({ user: m, assistantMsgs: [] })
        cur++
      } else if (cur >= 0) {
        groups[cur].assistantMsgs.push(m)
      }
    }

    const rounds: MessageRound[] = []
    for (const g of groups) {
      const lastIdx = g.assistantMsgs.length - 1
      const steps = lastIdx >= 0 ? g.assistantMsgs.slice(0, lastIdx) : []
      const reply = lastIdx >= 0 ? g.assistantMsgs[lastIdx] : null
      rounds.push(buildRound(g.user, steps, reply))
    }

    return rounds
  })

  const historyRounds = computed(() => {
    if (!sending.value) return messageRounds.value
    const rounds = messageRounds.value
    return rounds.length > 1 ? rounds.slice(0, -1) : []
  })

  const activeRound = computed(() => {
    if (!sending.value) return null
    const rounds = messageRounds.value
    return rounds.length > 0 ? rounds[rounds.length - 1] : null
  })

  const activeRoundMsgs = computed(() => {
    if (!activeRound.value) return [] as ChatMessage[]
    const round = activeRound.value
    const msgs: ChatMessage[] = []
    if (round.displaySteps.length > 0) msgs.push(...round.displaySteps)
    if (round.finalReply) msgs.push(round.finalReply)
    return mergeAdjacentToolMessages(msgs)
  })

  function toggleRound(roundId: string) {
    roundsExpanded.value[roundId] = !roundsExpanded.value[roundId]
  }

  return {
    roundsExpanded,
    messageRounds,
    historyRounds,
    activeRound,
    activeRoundMsgs,
    toggleRound,
  }
}
