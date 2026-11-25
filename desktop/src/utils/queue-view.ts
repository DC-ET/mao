import { splitUserMessageForDisplay, summarizeQuote, type DisplaySegment } from './selection-quote'
import type { FeishuInboundQueueItem, QueueRunningChannel } from '../types/chat'

/**
 * 待发送队列面板的纯展示逻辑（本地 message_queue 与飞书入站队列共用）。
 *
 * 抽成纯函数的原因：桌面端没有 @vue/test-utils，组件只能做源码结构断言；
 * 分组顺序、计数、折叠文案这些「会算错」的部分必须能脱离组件单测。
 */

/** 队列行展示预算（字符数）：文本段按字符计入，Tag 段按名称长度计入，超出则截断。回复引用单独折成短标签，不占这段预算。 */
export const QUEUE_DISPLAY_BUDGET = 60

export type QueueSegment = DisplaySegment | { type: 'quote'; content: string }

export interface QueueTruncateResult {
  segments: QueueSegment[]
  truncated: boolean
}

export type QueueGroupKey = 'local' | 'feishu'

function fileTagLength(seg: Extract<DisplaySegment, { type: 'file' }>): number {
  const name = seg.filePath.split(/[/\\]/).pop() || seg.filePath
  if (seg.lineStart == null) return name.length
  const end = seg.lineEnd ?? seg.lineStart
  return (end === seg.lineStart ? `${name}:${seg.lineStart}` : `${name}:${seg.lineStart}-${end}`).length
}

/** 队列行摘要：引用折成短标签，其余段按预算截断（与原 QueuePanel 内实现一致）。 */
export function truncateQueueSegments(content: string): QueueTruncateResult {
  const { quotes, segments } = splitUserMessageForDisplay(content || '')
  const out: QueueSegment[] = quotes.map(quote => ({ type: 'quote', content: summarizeQuote(quote, 24) }))
  let budget = QUEUE_DISPLAY_BUDGET
  let truncated = false
  for (const seg of segments) {
    if (budget <= 0) {
      truncated = true
      break
    }
    if (seg.type === 'text') {
      if (seg.content.length > budget) {
        out.push({ type: 'text', content: seg.content.slice(0, budget) })
        truncated = true
        break
      }
      out.push(seg)
      budget -= seg.content.length
    } else {
      const len = seg.type === 'file' ? fileTagLength(seg) : seg.name.length
      // 预算不足容纳整个 Tag 时不再展示，避免半个 Tag
      if (len >= budget) {
        truncated = true
        break
      }
      out.push(seg)
      budget -= len
    }
  }
  return { segments: out, truncated }
}

/** 面板里可见的排队项总数（决定根节点渲染、标题计数与折叠阈值）。 */
export function visibleQueueCount(localCount: number, inboundCount: number): number {
  return Math.max(0, localCount) + Math.max(0, inboundCount)
}

/**
 * 「下一组」标注：当前执行收尾后最先被消费的那一组。
 * - 某一组为空 → 另一组；
 * - 两组都有 → 由当前执行来源决定（飞书任务在跑则飞书队列先，本地任务在跑则本地先）；
 * - 两组都有但没有执行在跑（runningChannel=null）→ 返回 null，不猜顺序。
 */
export function nextQueueGroup(
  localCount: number,
  inboundCount: number,
  runningChannel: QueueRunningChannel,
): QueueGroupKey | null {
  const local = Math.max(0, localCount)
  const inbound = Math.max(0, inboundCount)
  if (local === 0 && inbound === 0) return null
  if (local === 0) return 'feishu'
  if (inbound === 0) return 'local'
  if (runningChannel === 'local') return 'local'
  if (runningChannel === 'feishu') return 'feishu'
  return null
}

/** 失败滞留提示：上一轮执行失败且仍有排队项时才展示。 */
export function shouldShowQueueBlocked(lastRunFailed: boolean, visibleCount: number): boolean {
  return lastRunFailed === true && visibleCount > 0
}

export interface InboundQueueSnapshot {
  items: FeishuInboundQueueItem[]
  runningChannel: QueueRunningChannel
  lastRunFailed: boolean
}

/**
 * 解析入站队列快照：恢复会话（fetchSessionQueue）与实时刷新（useStreamWS.refreshQueue）
 * 共用同一口径，避免两侧对缺字段/异常响应的默认值漂移。
 */
export function readInboundQueueSnapshot(data: unknown): InboundQueueSnapshot {
  const payload = (data ?? {}) as { items?: unknown; runningChannel?: unknown; lastRunFailed?: unknown }
  const channel = payload.runningChannel
  return {
    // 服务端异常响应不该打挂面板：非数组一律当空队列
    items: Array.isArray(payload.items) ? (payload.items as FeishuInboundQueueItem[]) : [],
    runningChannel: channel === 'local' || channel === 'feishu' ? channel : null,
    lastRunFailed: payload.lastRunFailed === true,
  }
}
