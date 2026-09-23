/** 深链进入 `/tasks/{id}` 时，左侧任务栏要把该会话露出来所需的分组调整。 */
export interface GroupReveal {
  groupKey: string
  /** 会话在分组内排序后的下标（0-based） */
  index: number
  /** 分组当前收起，需要展开 */
  expand: boolean
  /** 展开后至少要渲染到这一条（1-based 条数） */
  visibleCount: number
}

export function planGroupReveal(
  sessionId: string,
  groups: Array<{ key: string; sessionIds: Array<string | number> }>,
  collapsed: (key: string) => boolean,
  visibleCount: (key: string) => number,
): GroupReveal | null {
  const id = String(sessionId)
  for (const group of groups) {
    const index = group.sessionIds.findIndex((sid) => String(sid) === id)
    if (index < 0) continue
    const currentVisible = visibleCount(group.key)
    return {
      groupKey: group.key,
      index,
      expand: collapsed(group.key),
      visibleCount: Math.max(currentVisible, index + 1),
    }
  }
  return null
}

/** 聚焦模式：目标在主列表还是「历史」折叠区。 */
export interface FocusReveal {
  zone: 'main' | 'history'
  /** 主列表至少要渲染到的条数；历史区不使用 */
  visibleCount: number
  expandHistory: boolean
}

export function planFocusReveal(
  sessionId: string,
  focusMainIds: string[],
  historyIds: string[],
  focusVisibleCount: number,
  historyCollapsed: boolean,
): FocusReveal | null {
  const id = String(sessionId)
  const historyIndex = historyIds.findIndex((sid) => String(sid) === id)
  if (historyIndex >= 0) {
    return { zone: 'history', visibleCount: focusVisibleCount, expandHistory: historyCollapsed }
  }
  const index = focusMainIds.findIndex((sid) => String(sid) === id)
  if (index < 0) return null
  return {
    zone: 'main',
    visibleCount: Math.max(focusVisibleCount, index + 1),
    expandHistory: false,
  }
}
