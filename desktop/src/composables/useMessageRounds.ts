import { ref, computed, type Ref } from 'vue'
import type { DeliveryRef } from '@mao/contracts'
import { normalizeMessageRole, type ChatMessage, type FileChange, type SendDelivery, type ToolCall } from '../types/chat'
import { parseDateTime } from '../utils/datetime'
import { formatRelativeTime } from './useRelativeTime'
import { userAskExcerpt } from '../utils/selection-quote'

export interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  displaySteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
  fileChanges: FileChange[]
  deliveries: SendDelivery[]
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
    // 起点：用户消息发出时刻（服务端保存用户消息的时间，早于首个工具步骤）
    const first = user.createdAt
    // 终点：任务结束时刻（任务进入终态时后端会将最后一条消息的 updatedAt 刷新为结束时间）
    const lastMsg = reply || steps[steps.length - 1]
    const last = lastMsg.updatedAt || lastMsg.createdAt
    if (first && last) {
      const start = parseDateTime(first)
      const end = parseDateTime(last)
      if (start && end) {
        const diff = end.getTime() - start.getTime()
        if (diff > 0) {
          const s = Math.floor(diff / 1000)
          if (s < 60) {
            durationText = `${s}秒`
          } else if (s < 3600) {
            durationText = `${Math.floor(s / 60)}分${s % 60}秒`
          } else {
            const h = Math.floor(s / 3600)
            const m = Math.floor((s % 3600) / 60)
            durationText = `${h}小时${m}分钟`
          }
        }
      }
    }
  }
  const fileChanges: FileChange[] = [...steps, ...(reply ? [reply] : [])]
    .flatMap(m => m.fileChanges || [])
  const deliveries = collectRoundDeliveries([ ...steps, ...(reply ? [reply] : []) ])
  return {
    userMessage: user,
    collapsedSteps: steps,
    displaySteps: mergeAdjacentToolMessages(steps),
    finalReply: reply,
    stepCount,
    durationText,
    fileChanges,
    deliveries,
  }
}

/** 收集目标工具名：统一发送媒体（技术方案 2026-11-18-unified-send-media §7.1）。 */
const SEND_MEDIA_TOOL_NAMES = new Set(['send_image', 'send_file'])

/**
 * 从一轮消息的工具调用里按调用顺序收 send_image / send_file 的投递（D6；2026-11-20 §5.2；
 * 2026-11-24 快照）。结果 JSON 能解析且 delivery 含 url（形态 B，存量）或 ref（workspace 活引用
 * 仅存量 / send-file 快照 id）才收（保存失败无 delivery，不画）；
 * toolCall.result 由实时 tool_call_result 与刷新回放两条路回填，收集逻辑共用。
 */
export function collectRoundDeliveries(messages: ChatMessage[]): SendDelivery[] {
  const result: SendDelivery[] = []
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      const delivery = extractDelivery(call)
      if (delivery) result.push(delivery)
    }
  }
  return result
}

/**
 * 解析 delivery.ref（2026-11-24 send-file 补充）：按 type 分派。
 * - `workspace`：sessionId + path 齐备才认（存量形态 A）；
 * - `send-file`：快照 id（新发送默认形态）。
 * 其余形状一律返回 null（回落 url 形态）。注意：返回 null 会让整条 delivery 被
 * `extractDelivery` 丢弃，所以这里必须认识 `send-file`，否则新快照卡片根本不渲染。
 */
function parseDeliveryRef(raw: unknown): DeliveryRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.type === 'workspace') {
    if (typeof r.sessionId !== 'number' || typeof r.path !== 'string' || r.path === '') return null
    return { type: 'workspace', sessionId: r.sessionId, path: r.path }
  }
  if (r.type === 'send-file') {
    if (typeof r.id !== 'string' || r.id === '') return null
    return { type: 'send-file', id: r.id }
  }
  return null
}

function extractDelivery(call: ToolCall): SendDelivery | null {
  if (!SEND_MEDIA_TOOL_NAMES.has(call.name)) return null
  if (typeof call.result !== 'string' || call.result === '') return null
  try {
    const parsed = JSON.parse(call.result) as Record<string, unknown>
    const delivery = parsed.delivery as Record<string, unknown> | undefined
    if (!delivery || typeof delivery !== 'object') return null
    const url = typeof delivery.url === 'string' && delivery.url !== '' ? delivery.url : null
    const ref = parseDeliveryRef(delivery.ref)
    if (url == null && ref == null) return null
    const kind = delivery.kind === 'file' ? 'file' : 'image'
    // filename 回落链：结果级 → delivery 级 → 来源尾段（形态 A 取 ref.path basename）
    const sourceBasename = ref != null
      ? (ref.type === 'workspace' ? ref.path.split('/').pop() : null)
      : url?.split('/').pop()
    const filename = typeof parsed.filename === 'string' && parsed.filename.trim() !== ''
      ? parsed.filename
      : typeof delivery.filename === 'string' && delivery.filename.trim() !== ''
        ? delivery.filename
        : sourceBasename || 'attachment'
    return {
      kind,
      ...(url != null ? { url } : {}),
      ...(ref != null ? { ref } : {}),
      mime: typeof delivery.mime === 'string' ? delivery.mime : undefined,
      bytes: typeof delivery.bytes === 'number' ? delivery.bytes : undefined,
      filename,
    }
  } catch {
    return null
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

/**
 * 分叉切点只能是该轮助手的最终回复。
 * 点到展开后的中间步骤时，改回这一轮的最终回复；该轮没有最终回复则不能分叉。
 */
export function resolveForkCutPoint(rounds: MessageRound[], messageId: string): string | null {
  const round = rounds.find(candidate =>
    candidate.finalReply?.id === messageId
    || candidate.collapsedSteps.some(step => step.id === messageId)
    || candidate.displaySteps.some(step => step.id === messageId))
  return round?.finalReply?.id ?? null
}

export interface RoundDirectoryRow {
  /** 定位目标：该轮用户消息 id */
  id: string
  index: number
  summary: string
  time: string
  steps: string
}

/**
 * 轮次目录行数据：目录 = 已加载窗口索引（决策 7），调用方传 historyRounds
 * （执行中轮不列）。摘要只留用户真正的问题，回复引用和行区间片段不占这 16 字。
 */
export function toRoundDirectoryRows(rounds: MessageRound[]): RoundDirectoryRow[] {
  return rounds.map((round, idx) => {
    const summary = userAskExcerpt(round.userMessage.content ?? '').slice(0, 16)
    const steps = round.stepCount > 0
      ? `${round.stepCount} 步${round.durationText ? ` · ${round.durationText}` : ''}`
      : ''
    return {
      id: round.userMessage.id,
      index: idx + 1,
      summary,
      time: formatRelativeTime(round.userMessage.createdAt),
      steps,
    }
  })
}

/** 命中落在折叠步骤里时展开那一轮，否则气泡不在 DOM 中，无法滚动和高亮。 */
export function expandRoundContainingMessage(
  rounds: MessageRound[],
  expanded: Record<string, boolean>,
  messageId: string,
): boolean {
  for (const round of rounds) {
    const inSteps = round.collapsedSteps.some((step) => String(step.id) === messageId)
      || round.displaySteps.some((step) => String(step.id) === messageId)
    if (!inSteps) continue
    expanded[round.userMessage.id] = true
    return true
  }
  return false
}
