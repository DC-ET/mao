const STORAGE_PREFIX = 'mao:closed-side-tasks:'

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
