import { reactive } from 'vue'
import {
  cancelDislikeMessage,
  dislikeMessage,
  fetchDislikedMessageIds,
  type FeedbackReason
} from '../api'

export const FEEDBACK_REASON_OPTIONS: Array<{ value: FeedbackReason; label: string }> = [
  { value: 'WRONG_RESULT', label: '结果错误' },
  { value: 'SLOW_RESPONSE', label: '处理速度慢' },
  { value: 'NOT_SOLVED', label: '问题未解决' },
  { value: 'OTHER', label: '其他' }
]

// 模块级共享状态：主聊天 / 边路会话等多个面板共用同一份点踩集合
// sessionId -> Set<dislikedMessageId>
const dislikedBySession = reactive(new Map<number, Set<number>>())
// 提交中的消息 ID（防重复点击）
const submitting = reactive(new Set<number>())

/** 判断消息是否已点踩（sessionId 缺失或非数字视为未点踩）。 */
export function isMessageDisliked(sessionId: string | number | undefined, messageId: unknown): boolean {
  const sid = Number(sessionId)
  if (!Number.isInteger(sid) || sid <= 0) return false
  const mid = Number(messageId)
  if (!Number.isInteger(mid)) return false
  return dislikedBySession.get(sid)?.has(mid) ?? false
}

/** 消息是否具备点踩条件：服务端持久化的消息（数字 ID）才可点踩，本地乐观消息（msg_ 前缀）不可。 */
export function isDislikeEligible(messageId: unknown): boolean {
  if (typeof messageId === 'number') return Number.isInteger(messageId)
  if (typeof messageId === 'string') return /^-?\d+$/.test(messageId)
  return false
}

export function isDislikeSubmitting(messageId: unknown): boolean {
  const mid = Number(messageId)
  return Number.isInteger(mid) && submitting.has(mid)
}

/** 会话历史加载后调用一次，批量回显该会话内已点踩的消息。 */
export async function loadDislikedIds(sessionId: string | number): Promise<void> {
  const sid = Number(sessionId)
  if (!Number.isInteger(sid) || sid <= 0) return
  if (dislikedBySession.has(sid)) return // 已加载过，避免重复请求
  try {
    const ids = await fetchDislikedMessageIds(sid)
    dislikedBySession.set(sid, new Set(ids))
  } catch {
    // 回显失败不阻断聊天，仅缺失高亮态
  }
}

/** 提交点踩（原因单选即提交）。成功返回 true。 */
export async function submitDislike(sessionId: string | number | undefined, messageId: unknown, reason: FeedbackReason): Promise<boolean> {
  const sid = Number(sessionId)
  const mid = Number(messageId)
  if (!Number.isInteger(mid)) return false
  if (submitting.has(mid)) return false
  submitting.add(mid)
  try {
    await dislikeMessage(mid, reason)
    if (Number.isInteger(sid) && sid > 0) {
      const set = dislikedBySession.get(sid) ?? new Set<number>()
      set.add(mid)
      dislikedBySession.set(sid, set)
    }
    return true
  } catch {
    // 失败时 axios 拦截器已 toast，本地状态不变
    return false
  } finally {
    submitting.delete(mid)
  }
}

/** 取消点踩。成功返回 true。 */
export async function removeDislike(sessionId: string | number | undefined, messageId: unknown): Promise<boolean> {
  const sid = Number(sessionId)
  const mid = Number(messageId)
  if (!Number.isInteger(mid)) return false
  if (submitting.has(mid)) return false
  submitting.add(mid)
  try {
    await cancelDislikeMessage(mid)
    if (Number.isInteger(sid) && sid > 0) {
      dislikedBySession.get(sid)?.delete(mid)
    }
    return true
  } catch {
    return false
  } finally {
    submitting.delete(mid)
  }
}
