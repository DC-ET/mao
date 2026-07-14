import { ref, computed, watch, type Ref } from 'vue'
import type { Tab, SessionTabState } from '../types/file-browser'
import type { FileChange } from '../types/chat'
import { getClosedSideTaskIds, markSideTaskClosed, normalizeSideTaskTitle, type SideTaskSummary } from '../utils/side-task-tabs'

// Module-level singleton state
const sessionTabsMap = ref<Map<string, SessionTabState>>(new Map())
const currentSessionId = ref('')

const CHAT_TAB: Tab = { id: 'chat', type: 'chat', title: '主会话' }

export function useCenterTabs(activeSessionId: Ref<string | null>) {
  // Sync currentSessionId with the provided ref
  watch(activeSessionId, (newId) => {
    const sid = newId ?? ''
    if (sid !== currentSessionId.value) {
      currentSessionId.value = sid
    }
  }, { immediate: true })

  function notifyTabsChanged() {
    // Map 内部对象变更不会自动触发 computed，需要替换 Map 引用
    sessionTabsMap.value = new Map(sessionTabsMap.value)
  }

  function getSessionState(): SessionTabState {
    const sid = currentSessionId.value
    if (!sid) return { tabs: [], activeTabId: 'chat' }
    let state = sessionTabsMap.value.get(sid)
    if (!state) {
      state = { tabs: [], activeTabId: 'chat' }
      sessionTabsMap.value.set(sid, state)
    }
    return state
  }

  const tabs = computed<Tab[]>(() => {
    const state = getSessionState()
    return [CHAT_TAB, ...state.tabs]
  })

  const activeTabId = computed({
    get: () => getSessionState().activeTabId || 'chat',
    set: (val: string) => {
      const state = getSessionState()
      state.activeTabId = val
    }
  })

  const activeTab = computed(() => {
    return tabs.value.find(t => t.id === activeTabId.value) || CHAT_TAB
  })

  function openFileTab(filePath: string, title: string) {
    const state = getSessionState()
    // Check if tab already exists
    const existing = state.tabs.find(t => t.type === 'file' && t.filePath === filePath)
    if (existing) {
      // Increment version to force remount, ensuring latest file content is loaded
      existing.version = (existing.version ?? 0) + 1
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    // Use relative path as id (from title which is the filename, but filePath for uniqueness)
    const id = 'file:' + filePath
    const newTab: Tab = { id, type: 'file', title, filePath, version: 0 }
    state.tabs.push(newTab)
    state.activeTabId = id
  }

  function openDiffTab(change: FileChange, title?: string) {
    const state = getSessionState()
    const filePath = change.path
    const existing = state.tabs.find(t => t.type === 'diff' && t.filePath === filePath)
    if (existing) {
      existing.fileChange = { ...change }
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const fileName = filePath.split(/[/\\]/).pop() || filePath
    const tabTitle = title || `${fileName} (变更)`
    const id = 'diff:' + filePath
    const newTab: Tab = { id, type: 'diff', title: tabTitle, filePath, fileChange: { ...change } }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  /**
   * 打开边路任务 Tab。如果已存在则直接激活。
   * 传入 sideSessionId=0 表示"待创建"状态。
   */
  function openSideTaskTab(sideSessionId: number, title: string) {
    const state = getSessionState()
    const id = 'side:' + sideSessionId
    const existing = state.tabs.find(t => t.id === id)
    if (existing) {
      state.activeTabId = id
      return
    }
    const newTab: Tab = { id, type: 'side_task', title: normalizeSideTaskTitle(title), sideSessionId }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  /**
   * 更新边路任务 Tab（收到 side_session_created 后更新属性）。
   * 不改变 tab.id，保持组件不重新挂载。
   */
  function updateSideTaskTab(oldId: string, sideSessionId: number, title: string) {
    const state = getSessionState()
    const tab = state.tabs.find(t => t.id === oldId)
    if (tab) {
      // Don't change tab.id — keep the component mounted
      if (sideSessionId > 0) {
        tab.sideSessionId = sideSessionId
      }
      tab.title = normalizeSideTaskTitle(title)
      notifyTabsChanged()
    }
  }

  function closeTab(tabId: string) {
    if (tabId === 'chat') return // can't close chat tab
    const state = getSessionState()
    const idx = state.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return

    const tab = state.tabs[idx]
    if (tab.type === 'side_task' && tab.sideSessionId && tab.sideSessionId > 0) {
      markSideTaskClosed(currentSessionId.value, tab.sideSessionId)
    }

    state.tabs.splice(idx, 1)

    // If closing the active tab, switch to adjacent or chat
    if (state.activeTabId === tabId) {
      if (state.tabs.length > 0) {
        const newIdx = Math.min(idx, state.tabs.length - 1)
        state.activeTabId = state.tabs[newIdx].id
      } else {
        state.activeTabId = 'chat'
      }
    }
    notifyTabsChanged()
  }

  /**
   * 从后端恢复未关闭的边路任务 Tab（页面刷新后调用）。
   */
  function restoreSideTaskTabs(parentSessionId: string, sideTasks: SideTaskSummary[]) {
    if (!parentSessionId || sideTasks.length === 0) return
    const closed = getClosedSideTaskIds(parentSessionId)
    const state = sessionTabsMap.value.get(parentSessionId) ?? { tabs: [], activeTabId: 'chat' }
    let changed = false

    for (const st of sideTasks) {
      if (closed.has(st.id)) continue
      const id = 'side:' + st.id
      const existing = state.tabs.find(t => t.id === id || t.sideSessionId === st.id)
      if (existing) {
        existing.sideSessionId = st.id
        existing.title = normalizeSideTaskTitle(st.title)
        changed = true
        continue
      }
      const newTab: Tab = { id, type: 'side_task', title: normalizeSideTaskTitle(st.title), sideSessionId: st.id }
      state.tabs.push(newTab)
      changed = true
    }

    if (changed) {
      sessionTabsMap.value.set(parentSessionId, state)
      notifyTabsChanged()
    }
  }

  function activateTab(tabId: string) {
    const state = getSessionState()
    state.activeTabId = tabId
  }

  function closeAllFileTabs() {
    const state = getSessionState()
    state.tabs = []
    state.activeTabId = 'chat'
  }

  function closeOtherTabs(tabId: string) {
    const state = getSessionState()
    const tab = state.tabs.find(t => t.id === tabId)
    state.tabs = tab ? [tab] : []
    state.activeTabId = tabId
  }

  // Clean up tab state when session is deleted
  function removeSessionTabs(sessionId: string) {
    sessionTabsMap.value.delete(sessionId)
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    openFileTab,
    openDiffTab,
    openSideTaskTab,
    updateSideTaskTab,
    restoreSideTaskTabs,
    closeTab,
    closeAllFileTabs,
    closeOtherTabs,
    activateTab,
    removeSessionTabs,
  }
}
