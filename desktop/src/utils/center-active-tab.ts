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
