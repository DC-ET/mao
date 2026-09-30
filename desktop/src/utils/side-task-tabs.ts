import { safeRemoveItem, safeSetItem } from './safe-storage'

const STORAGE_PREFIX = 'mao:closed-side-tasks:'
const SIDE_TASK_TITLE_PREFIX = '[边路] '

/** 移除边路任务标题中的「边路」前缀（兼容历史数据） */
export function normalizeSideTaskTitle(title: string): string {
  if (!title) return '任务'
  if (title === '边路任务') return '任务'
  if (title.startsWith(SIDE_TASK_TITLE_PREFIX)) {
    return title.slice(SIDE_TASK_TITLE_PREFIX.length)
  }
  return title
}

export function getClosedSideTaskIds(parentSessionId: string): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + parentSessionId)
    const ids: number[] = raw ? JSON.parse(raw) : []
    return new Set(ids.map(Number).filter(id => id > 0))
  } catch {
    return new Set()
  }
}

export function markSideTaskClosed(parentSessionId: string, sideSessionId: number) {
  if (sideSessionId <= 0) return
  const closed = getClosedSideTaskIds(parentSessionId)
  closed.add(sideSessionId)
  safeSetItem(STORAGE_PREFIX + parentSessionId, JSON.stringify([...closed]))
}

/** 移除「用户曾关闭」记录：从搜索结果主动重新打开边路任务时调用，保证刷新后仍可恢复。 */
export function unmarkSideTaskClosed(parentSessionId: string, sideSessionId: number) {
  if (sideSessionId <= 0) return
  const closed = getClosedSideTaskIds(parentSessionId)
  if (!closed.has(sideSessionId)) return
  closed.delete(sideSessionId)
  safeSetItem(STORAGE_PREFIX + parentSessionId, JSON.stringify([...closed]))
}

/**
 * 登出/换号时清除全部关闭标记：key 不含用户维度（sessionId 是服务端自增数字），
 * 同机换号后 ID 碰撞会误隐藏新账号的边路 Tab。
 */
export function clearAllClosedSideTasks(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) safeRemoveItem(key)
  } catch {
    /* localStorage 不可用时放弃清理 */
  }
}

export interface SideTaskSummary {
  id: number
  title: string
  modelId?: number
  phase?: string
}
