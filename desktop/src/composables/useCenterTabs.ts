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
      notifyTabsChanged()
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
    notifyTabsChanged()
  }

  function openDiffTab(change: FileChange, title?: string, opts?: { source?: 'tool' | 'git' }) {
    const state = getSessionState()
    const filePath = change.path
    const source = opts?.source || 'tool'
    const idPrefix = source === 'git' ? 'git-diff:' : 'diff:'
    const existing = state.tabs.find(t => t.id === idPrefix + filePath || (t.type === 'diff' && t.filePath === filePath && t.id.startsWith(idPrefix)))
    if (existing) {
      existing.fileChange = { ...change }
      existing.title = title || existing.title
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const fileName = filePath.split(/[/\\]/).pop() || filePath
    const tabTitle = title || (source === 'git' ? `${fileName} (Git)` : `${fileName} (变更)`)
    const id = idPrefix + filePath
    const newTab: Tab = { id, type: 'diff', title: tabTitle, filePath, fileChange: { ...change } }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  function findSideTaskTab(state: SessionTabState, sideSessionId: number) {
    const id = 'side:' + sideSessionId
    return state.tabs.find(t =>
      t.type === 'side_task' && (t.id === id || t.sideSessionId === sideSessionId)
    )
  }

  function findSubagentTab(state: SessionTabState, childSessionId: number) {
    const id = 'subagent:' + childSessionId
    return state.tabs.find(t =>
      t.type === 'subagent' && (t.id === id || t.sideSessionId === childSessionId)
    )
  }

  /**
   * 打开边路任务 Tab。如果已存在则直接激活。
   * 传入 sideSessionId=0 表示"待创建"状态。
   * 占位 Tab 的 id 可能是 side:-{timestamp}，需按 sideSessionId 字段匹配。
   */
  function openSideTaskTab(sideSessionId: number, title: string) {
    const state = getSessionState()
    const existing = findSideTaskTab(state, sideSessionId)
    if (existing) {
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const id = 'side:' + sideSessionId
    const newTab: Tab = { id, type: 'side_task', title: normalizeSideTaskTitle(title), sideSessionId }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  /**
   * 打开子代理只读 Tab。如果已存在则直接激活。
   */
  function openSubagentTab(childSessionId: number, title: string) {
    if (childSessionId <= 0) return
    const state = getSessionState()
    const existing = findSubagentTab(state, childSessionId)
    if (existing) {
      existing.title = title || existing.title
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const id = 'subagent:' + childSessionId
    const newTab: Tab = {
      id,
      type: 'subagent',
      title: title || '子代理',
      sideSessionId: childSessionId,
    }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  /**
   * 更新边路任务 Tab（收到 side_session_created 后更新属性）。
   * 不改变 tab.id，保持组件不重新挂载。
   * oldId 可为占位 tab.id，也可传 side:{realId}；后者会按 sideSessionId 回退查找。
   */
  function updateSideTaskTab(oldId: string, sideSessionId: number, title: string) {
    const state = getSessionState()
    const tab = state.tabs.find(t => t.id === oldId)
      || (sideSessionId > 0 ? findSideTaskTab(state, sideSessionId) : undefined)
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

  /**
   * 恢复子代理 Tab（不自动打开全部，仅补齐已在 tabs 中的标题；列表点击再 openSubagentTab）。
   * 若传入 openAll=true，则为每个子代理打开 Tab（默认 false，避免刷新刷屏）。
   */
  function restoreSubagentTabs(
    parentSessionId: string,
    subagents: Array<{ id: number; title: string }>,
    opts?: { openAll?: boolean }
  ) {
    if (!parentSessionId || subagents.length === 0) return
    if (!opts?.openAll) return
    const state = sessionTabsMap.value.get(parentSessionId) ?? { tabs: [], activeTabId: 'chat' }
    let changed = false
    for (const sa of subagents) {
      const id = 'subagent:' + sa.id
      const existing = state.tabs.find(t => t.type === 'subagent' && (t.id === id || t.sideSessionId === sa.id))
      if (existing) {
        existing.sideSessionId = sa.id
        existing.title = sa.title || existing.title
        changed = true
        continue
      }
      state.tabs.push({
        id,
        type: 'subagent',
        title: sa.title || '子代理',
        sideSessionId: sa.id,
      })
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
    notifyTabsChanged()
  }

  /** 仅关闭文件类标签（file / diff），保留边路任务 / 子代理等非文件标签。 */
  function closeAllFileTabs() {
    const state = getSessionState()
    state.tabs = state.tabs.filter(t => t.type !== 'file' && t.type !== 'diff')
    if (state.activeTabId !== 'chat' && !state.tabs.some(t => t.id === state.activeTabId)) {
      state.activeTabId = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1].id : 'chat'
    }
    notifyTabsChanged()
  }

  function closeOtherTabs(tabId: string) {
    const state = getSessionState()
    const tab = state.tabs.find(t => t.id === tabId)
    state.tabs = tab ? [tab] : []
    state.activeTabId = tabId
    notifyTabsChanged()
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
    openSubagentTab,
    updateSideTaskTab,
    restoreSideTaskTabs,
    restoreSubagentTabs,
    closeTab,
    closeAllFileTabs,
    closeOtherTabs,
    activateTab,
    removeSessionTabs,
  }
}
