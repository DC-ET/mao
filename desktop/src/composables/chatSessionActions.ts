import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useStreamWS } from './useStreamWS'

/** 拉取会话待发送队列（取消后的状态回填等场景只有 sessionId，没有输入框上下文） */
export async function fetchSessionQueue(sessionId: string): Promise<void> {
  const sessionStore = useSessionStore()
  const sid = String(sessionId)
  try {
    const { data } = await api.get(`/sessions/${sid}/queue`)
    sessionStore.setQueueMessages(sid, data || [])
  } catch {
    // ignore：队列拉取失败不影响主流程，后续事件会再刷新
  }
}

/**
 * 发送前的附件上传防线（主会话 / 边路任务共用）：
 * 全部失败 → 提示并阻断；部分失败 → 弹「仍然发送 / 取消」；最终内容为空 → 阻断。
 * 返回 true 才可继续发送。
 */
export async function guardUploadsBeforeSend(params: {
  imageCount: number
  imageUrls: string[]
  fileCount: number
  uploadedFileCount: number
  resolvedText: string
}): Promise<boolean> {
  const { imageCount, imageUrls, fileCount, uploadedFileCount, resolvedText } = params
  const total = imageCount + fileCount
  const succeeded = imageUrls.length + uploadedFileCount
  if (total > 0 && succeeded === 0) {
    ElMessage.error('附件全部上传失败，已取消发送')
    return false
  }
  if (succeeded < total) {
    try {
      await ElMessageBox.confirm(
        `${total - succeeded} 个附件上传失败，仍要发送其余内容吗？`,
        '部分附件上传失败',
        { confirmButtonText: '仍然发送', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return false
    }
  }
  if (!resolvedText.trim() && imageUrls.length === 0) {
    ElMessage.warning('消息内容为空，已取消发送')
    return false
  }
  return true
}

/**
 * 等待 `user_message_saved`：只在服务端确认落库后返回 true。
 * 超时 / 主动取消返回 false（调用方据此决定是否清空输入框）。
 *
 * sessionId 支持传 getter：边路首发尚未拿到真实会话 id，需要等
 * `side_session_created` 回填后再匹配。
 */
export function waitForMessageSaved(
  sessionId: string | (() => string | null),
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  const { onMessageSaved, offMessageSaved } = useStreamWS()
  const signal = options?.signal
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let callbackId = ''

    const onAbort = () => finish(false)
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer != null) clearTimeout(timer)
      offMessageSaved(callbackId)
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }

    callbackId = onMessageSaved((callbackSessionId: string) => {
      const expected = typeof sessionId === 'function' ? sessionId() : sessionId
      if (expected != null && callbackSessionId === String(expected)) finish(true)
    })

    if (signal?.aborted) {
      finish(false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(false), options?.timeoutMs ?? 60000)
  })
}

/**
 * 等待本轮执行收敛（终态 / 失败）。
 * 与 useStreamWS 的 pendingCallbacks 同源：主会话的停止后重试、发送后等待完成
 * 与边路任务的重试都走这里，避免各自维护一份等待逻辑。
 */
export function awaitExecutionSettled(sessionId: string): Promise<void> {
  const { pendingCallbacks } = useStreamWS()
  const sid = String(sessionId)
  const superseded = pendingCallbacks.get(sid)
  if (superseded) {
    // 单槽 Map：同一会话只保留最后一个等待者，旧等待者显式失败而不是永远悬挂
    pendingCallbacks.delete(sid)
    // toastShown：调用方的 catch 会按 error.message 弹提示，这条是内部状态而非用户错误
    superseded.reject?.(Object.assign(new Error('superseded by a newer wait'), { toastShown: true }))
  }
  return new Promise<void>((resolve, reject) => {
    pendingCallbacks.set(sid, { resolve, reject })
  })
}

/**
 * 取消执行的本地收尾（主会话 / 边路任务同一套）。
 *
 * 顺序有讲究：必须先把正在流式的气泡标记为「已中止」，再做终态重拉，
 * 否则 REST 覆盖会把已流出内容的唯一副本当成尾部残留删掉。
 */
export function finalizeCancelledSession(sessionId: string): void {
  const sid = String(sessionId)
  const { clearActiveExecution, pendingCallbacks } = useStreamWS()
  const sessionStore = useSessionStore()

  clearActiveExecution(sid)
  sessionStore.setThinking(sid, false)
  sessionStore.setStreaming(sid, false)
  sessionStore.setCompacting(sid, false)
  sessionStore.clearAskQuestions(sid)
  sessionStore.clearLlmRetry(sid)
  sessionStore.finishInterruptedStreamingMessage(sid, '执行已被中止')
  sessionStore.updateSessionPhase(sid, 'CANCELLED')

  // clearActiveExecution 会让后续 CANCELLED 帧被陈旧过滤器吞掉，
  // 必须在这里手工唤醒等待本轮收敛的调用方（否则停止后重试会一直挂着）
  const pending = pendingCallbacks.get(sid)
  if (pending) {
    pendingCallbacks.delete(sid)
    pending.resolve?.()
  }

  void fetchSessionQueue(sid)
}
