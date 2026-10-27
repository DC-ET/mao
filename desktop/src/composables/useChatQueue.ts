import { nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useStreamWS } from './useStreamWS'
import { fetchImagesAsFiles } from '../utils/file'
import { fetchSessionQueue } from './chatSessionActions'
import type { QueueMessage } from '../types/chat'

/** 「撤回编辑」需要的最小输入框能力（ChatInput defineExpose 的子集） */
export interface QueueEditTarget {
  hasDraft(): boolean
  restoreContent(
    text: string,
    files: File[],
    quotes?: Array<{ id: string; text: string; truncated: boolean }>,
  ): void
  focusInput(): void
}

/**
 * 会话待发送队列（主会话 / 边路任务共用）。
 *
 * 两侧原本各写一份，差异只有「会话 id 从哪来」：主会话用 activeSessionId，
 * 边路用 realSessionId（可能是 0 = 占位态）。这里用 getSessionId 注入，
 * 输入框能力用 getInput 注入（撤回编辑要把队列消息回填到对应输入框）。
 */
export function useChatQueue(
  getSessionId: () => string | null | undefined,
  getInput?: () => QueueEditTarget | null | undefined,
) {
  const {
    insertMessage,
    deleteQueueMessage: wsDeleteQueueMessage,
    reorderQueueMessage: wsReorderQueueMessage,
  } = useStreamWS()

  async function fetchQueue(): Promise<void> {
    const sid = getSessionId()
    if (!sid) return
    await fetchSessionQueue(String(sid))
  }

  async function insertQueueMessage(queueId: string): Promise<void> {
    const sid = getSessionId()
    if (!sid) return
    if (!await insertMessage(String(sid), queueId)) {
      ElMessage.error('操作失败，网络连接不可用，请重试')
    }
  }

  async function deleteQueueMessage(queueId: string): Promise<boolean> {
    const sid = getSessionId()
    if (!sid) return false
    if (!await wsDeleteQueueMessage(String(sid), queueId)) {
      ElMessage.error('操作失败，网络连接不可用，请重试')
      return false
    }
    return true
  }

  async function reorderQueueMessage(queueId: string, targetIndex: number): Promise<void> {
    const sid = getSessionId()
    if (!sid) return
    if (!await wsReorderQueueMessage(String(sid), queueId, targetIndex)) {
      ElMessage.error('操作失败，网络连接不可用，请重试')
    }
  }

  /** 队列消息撤回编辑：确认覆盖草稿 → 取回图片 → 删除队列项 → 回填输入框 */
  async function handleQueueEdit(msg: QueueMessage): Promise<void> {
    const input = getInput?.()
    // 没有可回填的输入框就不要删队列项，否则消息内容会静默丢失
    if (!input) return
    if (input.hasDraft()) {
      try {
        await ElMessageBox.confirm('输入框已有未发送内容，撤回将覆盖，是否继续？', '编辑队列消息', {
          confirmButtonText: '覆盖并编辑',
          cancelButtonText: '取消',
          type: 'warning',
        })
      } catch {
        return
      }
    }
    let files: File[] = []
    if (msg.images && msg.images.length > 0) {
      try {
        files = await fetchImagesAsFiles(msg.images)
      } catch {
        ElMessage.error('图片获取失败，已取消编辑')
        return
      }
    }
    const deleted = await deleteQueueMessage(msg.id)
    if (!deleted) return
    // 确认/取图期间面板可能切换输入框实例（主会话有居中态与 docked 两个 ChatInput），
    // 回填时重新取一次，拿不到再退回早退时捕获的实例
    const target = getInput?.() ?? input
    target.restoreContent(msg.content, files, [])
    nextTick(() => target.focusInput())
  }

  return { fetchQueue, insertQueueMessage, deleteQueueMessage, reorderQueueMessage, handleQueueEdit }
}
