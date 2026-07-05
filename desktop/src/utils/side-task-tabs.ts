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
  localStorage.setItem(STORAGE_PREFIX + parentSessionId, JSON.stringify([...closed]))
}

export interface SideTaskSummary {
  id: number
  title: string
  modelId?: number
  phase?: string
}
