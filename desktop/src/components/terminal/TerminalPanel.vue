<template>
  <div v-show="isOpen" ref="panelRef" class="terminal-panel" :style="{ height: panelHeight + 'px' }">
    <div class="terminal-resize-handle" @mousedown="startResize" @touchstart.prevent="startResize" />
    <div class="terminal-header">
      <TerminalTabs
        :tabs="visibleTabs"
        :active-id="activeTabId"
        @switch="handleSwitch"
        @close="closeTerminal"
        @create="handleCreate"
      />
      <button class="terminal-panel-close" @click="togglePanel()" title="关闭终端 (Ctrl+`)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div v-if="searchVisible" class="terminal-search">
      <input
        ref="searchInputRef"
        v-model="searchTerm"
        class="terminal-search-input"
        placeholder="搜索终端内容"
        @keydown.enter.prevent="handleSearchEnter"
        @keydown.esc.prevent="closeSearch"
        @input="searchNext(true)"
      />
      <span class="terminal-search-count">{{ searchCountText }}</span>
      <button class="terminal-search-btn" title="上一个 (Shift+Enter)" @click="searchPrevious">↑</button>
      <button class="terminal-search-btn" title="下一个 (Enter)" @click="searchNext()">↓</button>
      <button class="terminal-search-btn" title="关闭 (Esc)" @click="closeSearch">✕</button>
    </div>
    <div v-if="activeTakenOver" class="terminal-takeover">
      <span>该终端已在其他窗口接管，此处已停止接收输出。</span>
      <button class="terminal-takeover-btn" @click="handleReattach">重新接管</button>
    </div>
    <div class="terminal-container">
      <div
        v-for="tab in visibleTabs"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        :ref="(el) => setContainerRef(tab.id, el as HTMLElement | null)"
        class="terminal-instance"
      />
      <div v-if="visibleTabs.length === 0" class="terminal-empty">当前任务没有终端，点击 + 新建</div>
    </div>
    <div v-if="showKeyBar" class="terminal-keybar">
      <button
        v-for="key in KEY_BAR"
        :key="key.label"
        class="terminal-keybar-btn"
        :class="{ active: key.label === 'Ctrl' && ctrlSticky }"
        @click="handleKeyBar(key)"
      >{{ key.label }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { useTerminal } from '../../composables/useTerminal'
import { useSessionStore } from '../../stores/session'
import { isAndroidCapacitor } from '../../utils/capacitor'
import TerminalTabs from './TerminalTabs.vue'

const {
  visibleTabs,
  activeTabId,
  isOpen,
  takenOverTabs,
  createTerminal,
  restoreRemoteTabs,
  detachRemoteTerminals,
  reattachRemoteTerminal,
  mountTerminal,
  fitTerminal,
  fitAllTerminals,
  switchTab,
  closeTerminal,
  togglePanel,
  getActiveInstance,
  getInstance,
} = useTerminal()

const sessionStore = useSessionStore()

const panelRef = ref<HTMLElement | null>(null)
const panelHeight = ref(300)
const MIN_HEIGHT = 100
const MAX_HEIGHT_RATIO = 0.7

const containerRefs = new Map<string, HTMLElement>()
const mountedTerminals = new Set<string>()

function setContainerRef(id: string, el: HTMLElement | null) {
  if (el) {
    containerRefs.set(id, el)
  } else {
    containerRefs.delete(id)
    mountedTerminals.delete(id)
  }
}

watch(activeTabId, (newId) => {
  if (!newId) return
  nextTick(() => {
    const container = containerRefs.get(newId)
    if (container && !mountedTerminals.has(newId)) {
      mountedTerminals.add(newId)
      mountTerminal(newId, container)
    } else {
      // Focus existing terminal when switching tabs
      const inst = getActiveInstance()
      if (inst) inst.terminal.focus()
    }
    fitTerminal(newId)
  })
})

watch(
  () => visibleTabs.value.length,
  () => {
    nextTick(() => {
      if (activeTabId.value) {
        const container = containerRefs.get(activeTabId.value)
        if (container && !mountedTerminals.has(activeTabId.value)) {
          mountedTerminals.add(activeTabId.value)
          mountTerminal(activeTabId.value, container)
        }
      }
    })
  }
)

/** 切任务：解绑旧任务终端（让后端能按 idle 回收），再与后端对齐当前任务的 tab。 */
watch(() => sessionStore.activeSessionId, async () => {
  closeSearch()
  const session = sessionStore.activeSession
  detachRemoteTerminals(session?.executionMode === 'CLOUD' ? session.id : null)
  if (isOpen.value && session?.executionMode === 'CLOUD') {
    await restoreRemoteTabs(session.id)
  }
  if (!activeTabId.value || !visibleTabs.value.some((t) => t.id === activeTabId.value)) {
    activeTabId.value = visibleTabs.value[0]?.id ?? null
  }
})

watch(isOpen, async (open) => {
  if (!open) {
    closeSearch()
    return
  }
  const session = sessionStore.activeSession
  if (session?.executionMode === 'CLOUD') {
    await restoreRemoteTabs(session.id)
  }
})

async function handleCreate() {
  const session = sessionStore.activeSession
  let cwd: string | undefined
  if (session?.executionMode === 'LOCAL' && session.workspace) {
    cwd = session.workspace
  }
  await createTerminal(cwd)
}

function handleSwitch(id: string) {
  switchTab(id)
}

/** 当前 tab 是否被其他窗口接管（需用户手动重新接管）。 */
const activeTakenOver = computed(() => activeTabId.value != null && takenOverTabs.value.includes(activeTabId.value))

function handleReattach() {
  if (activeTabId.value) reattachRemoteTerminal(activeTabId.value)
}

/* ---------------- 终端内搜索（Ctrl+F） ---------------- */

const searchVisible = ref(false)
const searchTerm = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchResult = ref<{ index: number; count: number } | null>(null)
let searchResultDisposer: (() => void) | null = null

const searchCountText = computed(() => {
  if (!searchTerm.value) return ''
  const result = searchResult.value
  if (!result || result.count === 0) return '无结果'
  return `${result.index + 1}/${result.count}`
})

const SEARCH_OPTIONS = {
  decorations: {
    matchOverviewRuler: '#d7ba7d',
    activeMatchColorOverviewRuler: '#ff9f0a',
    matchBackground: '#5c4b1f',
    activeMatchBackground: '#ff9f0a',
  },
}

function subscribeSearchResults() {
  searchResultDisposer?.()
  searchResultDisposer = null
  const inst = getActiveInstance()
  if (!inst) return
  const disposable = inst.searchAddon.onDidChangeResults((result) => {
    searchResult.value = result ? { index: result.resultIndex, count: result.resultCount } : null
  })
  searchResultDisposer = () => disposable.dispose()
}

function openSearch() {
  if (!activeTabId.value) return
  searchVisible.value = true
  subscribeSearchResults()
  nextTick(() => {
    searchInputRef.value?.focus()
    searchInputRef.value?.select()
  })
}

function closeSearch() {
  if (!searchVisible.value) return
  searchVisible.value = false
  searchResult.value = null
  searchResultDisposer?.()
  searchResultDisposer = null
  getActiveInstance()?.searchAddon.clearDecorations()
  getActiveInstance()?.terminal.focus()
}

function clearDecorations(id: string) {
  getInstance(id)?.searchAddon.clearDecorations()
}

function searchNext(incremental = false) {
  const inst = getActiveInstance()
  if (!inst || !searchTerm.value) {
    searchResult.value = null
    inst?.searchAddon.clearDecorations()
    return
  }
  inst.searchAddon.findNext(searchTerm.value, { ...SEARCH_OPTIONS, incremental })
}

function searchPrevious() {
  const inst = getActiveInstance()
  if (!inst || !searchTerm.value) return
  inst.searchAddon.findPrevious(searchTerm.value, SEARCH_OPTIONS)
}

function handleSearchEnter(e: KeyboardEvent) {
  if (e.shiftKey) searchPrevious()
  else searchNext()
}

/** Ctrl+F 仅在面板打开且事件源在面板内时拦截，避免劫持浏览器全局查找。 */
function handleSearchKeydown(e: KeyboardEvent) {
  if (!isOpen.value) return
  const inPanel = panelRef.value?.contains(e.target as Node) ?? false
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && inPanel) {
    e.preventDefault()
    openSearch()
    return
  }
  if (e.key === 'Escape' && searchVisible.value && inPanel) {
    e.preventDefault()
    closeSearch()
  }
}

watch(activeTabId, (_newId, oldId) => {
  // 粘滞 Ctrl 只对当前终端有意义，切走后复位避免下一个终端首个字母变控制字符
  ctrlSticky.value = false
  if (searchVisible.value) {
    // 清掉上一个终端的搜索高亮，再把结果订阅切到新终端
    if (oldId) clearDecorations(oldId)
    subscribeSearchResults()
    searchNext(true)
  }
})

/* ---------------- 安卓虚拟按键条与软键盘避让 ---------------- */

interface KeyBarItem {
  label: string
  data?: string
  action?: 'ctrl' | 'paste'
}

const KEY_BAR: KeyBarItem[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', action: 'ctrl' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: '粘贴', action: 'paste' },
]

const showKeyBar = isAndroidCapacitor()
const ctrlSticky = ref(false)

/** 统一走 xterm 的 input()：会触发 onData，local / remote 自动走各自写入通道。 */
function sendToTerminal(data: string) {
  getActiveInstance()?.terminal.input(data)
}

async function handleKeyBar(key: KeyBarItem) {
  if (key.action === 'ctrl') {
    ctrlSticky.value = !ctrlSticky.value
    return
  }
  if (key.action === 'paste') {
    try {
      const text = await navigator.clipboard.readText()
      if (text) sendToTerminal(text)
    } catch {
      ElMessage.warning('无法读取剪贴板')
    }
    return
  }
  if (key.data) sendToTerminal(key.data)
}

/** Ctrl 粘滞键：置位后下一个字母键转为控制字符，发送后自动复位。 */
function handleStickyCtrl(e: KeyboardEvent) {
  if (!ctrlSticky.value) return
  if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) return
  e.preventDefault()
  e.stopPropagation()
  const code = e.key.toLowerCase().charCodeAt(0) - 96
  sendToTerminal(String.fromCharCode(code))
  ctrlSticky.value = false
}

/** 软键盘避让：用 visualViewport 计算底部遮挡，给面板加 margin-bottom 并 refit。 */
function handleViewportChange() {
  const vv = window.visualViewport
  const panel = panelRef.value
  if (!vv || !panel) return
  const occluded = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
  panel.style.marginBottom = occluded > 0 ? `${occluded}px` : ''
  if (activeTabId.value) {
    nextTick(() => fitTerminal(activeTabId.value!))
  }
}

function startResize(e: MouseEvent | TouchEvent) {
  e.preventDefault()
  const touch = 'touches' in e ? e.touches[0] : null
  const startY = touch ? touch.clientY : (e as MouseEvent).clientY
  const startHeight = panelHeight.value

  function applyResize(clientY: number) {
    const delta = startY - clientY
    const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO
    panelHeight.value = Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + delta))
    if (activeTabId.value) {
      fitTerminal(activeTabId.value)
    }
  }

  function onMove(e: MouseEvent) {
    applyResize(e.clientY)
  }

  function onTouchMove(e: TouchEvent) {
    const t = e.touches[0]
    if (t) applyResize(t.clientY)
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('touchend', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('touchmove', onTouchMove, { passive: true })
  document.addEventListener('touchend', onUp)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

function handleWindowResize() {
  fitAllTerminals()
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
  document.addEventListener('keydown', handleSearchKeydown)
  if (showKeyBar) {
    document.addEventListener('keydown', handleStickyCtrl, true)
    // visualViewport 在桌面浏览器与 Electron 也存在，仅安卓注册避免误触发
    window.visualViewport?.addEventListener('resize', handleViewportChange)
    window.visualViewport?.addEventListener('scroll', handleViewportChange)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
  document.removeEventListener('keydown', handleSearchKeydown)
  if (showKeyBar) {
    document.removeEventListener('keydown', handleStickyCtrl, true)
    window.visualViewport?.removeEventListener('resize', handleViewportChange)
    window.visualViewport?.removeEventListener('scroll', handleViewportChange)
  }
  searchResultDisposer?.()
  searchResultDisposer = null
})
</script>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  background: var(--aw-canvas);
  border-top: 1px solid var(--aw-divider-soft);
  position: relative;
  flex-shrink: 0;
}

.terminal-resize-handle {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 10;
}

.terminal-resize-handle:hover {
  background: var(--aw-primary);
  opacity: 0.2;
}

@media (pointer: coarse) {
  .terminal-resize-handle {
    top: -8px;
    height: 16px;
  }
}

.terminal-header {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.terminal-header .terminal-tabs {
  flex: 1;
  min-width: 0;
}

.terminal-panel-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 36px;
  border: none;
  background: var(--aw-terminal-header-bg);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.terminal-panel-close:hover {
  color: var(--aw-ink);
  background: var(--aw-divider-soft);
}

.terminal-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 4px 12px;
  background: var(--aw-terminal-header-bg);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.terminal-search-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 4px;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 12px;
  outline: none;
}

.terminal-search-input:focus {
  border-color: var(--aw-primary);
}

.terminal-search-count {
  flex-shrink: 0;
  min-width: 48px;
  text-align: right;
  color: var(--aw-ink-muted-60);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.terminal-search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--aw-ink-muted-60);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}

.terminal-search-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-divider-soft);
}

.terminal-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--aw-terminal-bg);
  padding: 4px 16px;
}

.terminal-takeover {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 4px 12px;
  background: var(--aw-terminal-header-bg);
  border-bottom: 1px solid var(--aw-divider-soft);
  color: var(--aw-ink-muted-60);
  font-size: 12px;
}

.terminal-takeover-btn {
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--aw-primary);
  border-radius: 4px;
  background: transparent;
  color: var(--aw-primary);
  font-size: 12px;
  cursor: pointer;
}

.terminal-takeover-btn:hover {
  background: var(--aw-divider-soft);
}

.terminal-instance {
  width: 100%;
  height: 100%;
}

.terminal-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
  user-select: none;
}

.terminal-keybar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 8px;
  overflow-x: auto;
  background: var(--aw-terminal-header-bg);
  border-top: 1px solid var(--aw-divider-soft);
  scrollbar-width: none;
}

.terminal-keybar::-webkit-scrollbar {
  display: none;
}

.terminal-keybar-btn {
  flex-shrink: 0;
  min-width: 40px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 12px;
  cursor: pointer;
}

.terminal-keybar-btn:active {
  background: var(--aw-divider-soft);
}

.terminal-keybar-btn.active {
  border-color: var(--aw-primary);
  color: var(--aw-primary);
}
</style>
