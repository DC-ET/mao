import { ref, computed, watch, type Ref } from 'vue'
import type { Tab, SessionTabState } from '../types/file-browser'
import type { FileChange } from '../types/chat'

// Module-level singleton state
const sessionTabsMap = ref<Map<string, SessionTabState>>(new Map())
const currentSessionId = ref('')

const CHAT_TAB: Tab = { id: 'chat', type: 'chat', title: '聊天' }

export function useCenterTabs(activeSessionId: Ref<string | null>) {
  // Sync currentSessionId with the provided ref
  watch(activeSessionId, (newId) => {
    const sid = newId ?? ''
    if (sid !== currentSessionId.value) {
      currentSessionId.value = sid
    }
  }, { immediate: true })

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
      return
    }
    const fileName = filePath.split(/[/\\]/).pop() || filePath
    const tabTitle = title || `${fileName} (变更)`
    const id = 'diff:' + filePath
    const newTab: Tab = { id, type: 'diff', title: tabTitle, filePath, fileChange: { ...change } }
    state.tabs.push(newTab)
    state.activeTabId = id
  }

  function closeTab(tabId: string) {
    if (tabId === 'chat') return // can't close chat tab
    const state = getSessionState()
    const idx = state.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return

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
    closeTab,
    closeAllFileTabs,
    closeOtherTabs,
    activateTab,
    removeSessionTabs,
  }
}
