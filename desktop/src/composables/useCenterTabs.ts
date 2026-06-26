import { ref, computed, watch, type Ref } from 'vue'
import type { Tab, SessionTabState } from '../types/file-browser'

// Module-level singleton state
const sessionTabsMap = ref<Map<string, SessionTabState>>(new Map())
const currentSessionId = ref('')

const CHAT_TAB: Tab = { id: 'chat', type: 'chat', title: '对话' }

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
    const existing = state.tabs.find(t => t.filePath === filePath)
    if (existing) {
      state.activeTabId = existing.id
      return
    }
    // Use relative path as id (from title which is the filename, but filePath for uniqueness)
    const id = 'file:' + filePath
    const newTab: Tab = { id, type: 'file', title, filePath }
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
    closeTab,
    closeAllFileTabs,
    closeOtherTabs,
    activateTab,
    removeSessionTabs,
  }
}
