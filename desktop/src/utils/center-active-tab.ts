import { safeRemoveItem, safeSetItem } from './safe-storage'

const STORAGE_PREFIX = 'mao:center-active-tab:'

/**
 * 最后激活的中心 Tab（按父会话记录，最多只留最近一个会话）。
 * 中心 Tab 状态本身只在内存：刷新 / 冷启动后边路任务 Tab 靠 restoreSideTaskTabs 重建，
 * 但「重建后激活哪个」此前恒为 chat。这里补上激活态，使上次停在边路任务 / 文件 Tab 时
 * 刷新后能直接回到那个 Tab（与 mao_last_session_id 还原最后会话配对）。
 */
export interface PersistedActiveTab {
  /** Tab 类型：side_task / subagent 用 sideSessionId 锚定，file / diff 用 tabId 锚定 */
  type: string
  /** 边路任务 / 子代理锚点：子会话 ID（与 tab id 解耦，见 useCenterTabs 的说明） */
  sideSessionId?: number
  /** 文件 / diff 类 Tab 的 id：'file:{path}' / 'diff:{path}' / 'git-diff:{path}' */
  tabId?: string
}

export function getPersistedActiveTab(parentSessionId: string): PersistedActiveTab | null {
  if (!parentSessionId) return null
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + parentSessionId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedActiveTab
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null
    const hasSide = typeof parsed.sideSessionId === 'number' && parsed.sideSessionId > 0
    const hasTab = typeof parsed.tabId === 'string' && parsed.tabId.length > 0
    if (!hasSide && !hasTab) return null
    return parsed
  } catch {
    return null
  }
}

export function persistActiveTab(parentSessionId: string, tab: PersistedActiveTab | null): void {
  if (!parentSessionId) return
  if (!tab) {
    safeRemoveItem(STORAGE_PREFIX + parentSessionId)
    return
  }
  safeSetItem(STORAGE_PREFIX + parentSessionId, JSON.stringify(tab))
}

/**
 * 冷启动点名还原目标（边路任务口径）：持久化激活态指向某个边路任务、且它仍在
 * 递归列表里时，给出要单独补建的 ID 集合；目标已删除（不在列表）或激活态不是
 * side_task 时返回 undefined，调用方维持「仅直接子级」口径。
 * 把 loadSession 里「读激活态 → 对递归列表点名」的接线收成纯函数，便于单测。
 */
export function resolveSideTaskRestoreIds(
  persisted: PersistedActiveTab | null,
  sideTasks: ReadonlyArray<{ id: number }>,
): Set<number> | undefined {
  const anchor = persisted?.sideSessionId
  if (!persisted || persisted.type !== 'side_task' || anchor == null) return undefined
  return sideTasks.some((st) => st.id === anchor) ? new Set([anchor]) : undefined
}

/** 同 resolveSideTaskRestoreIds，子代理 Tab 口径：返回要补建的子代理会话 ID，无点名目标为 null。 */
export function resolveSubagentRestoreId(
  persisted: PersistedActiveTab | null,
  subagents: ReadonlyArray<{ id: number }>,
): number | null {
  const anchor = persisted?.sideSessionId
  if (!persisted || persisted.type !== 'subagent' || anchor == null) return null
  return subagents.some((sa) => sa.id === anchor) ? anchor : null
}

/**
 * 登出/换号时清除全部激活态记录：key 不含用户维度（sessionId 是服务端自增数字），
 * 同机换号后 ID 碰撞会激活新账号下的同 ID Tab。
 */
export function clearAllPersistedActiveTabs(): void {
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
