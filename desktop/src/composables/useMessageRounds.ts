import { ref, computed, type Ref } from 'vue'
import { normalizeMessageRole, type ChatMessage, type FileChange } from '../types/chat'

export interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
  fileChanges: FileChange[]
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
        const s = Math.floor(diff / 1000)
        durationText = s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`
      }
    }
  }
  const fileChanges: FileChange[] = [...steps, ...(reply ? [reply] : [])]
    .flatMap(m => m.fileChanges || [])
  return { userMessage: user, collapsedSteps: steps, finalReply: reply, stepCount, durationText, fileChanges }
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
    if (round.collapsedSteps.length > 0) msgs.push(...round.collapsedSteps)
    if (round.finalReply) msgs.push(round.finalReply)
    return msgs
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
