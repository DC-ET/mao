<template>
  <div
    v-show="isOpen"
    ref="panelRef"
    class="terminal-panel"
    :class="{ 'terminal-panel--touch': isTouch }"
    :style="{ height: effectiveHeight + 'px' }"
  >
    <div class="terminal-resize-handle" @mousedown="startResize" @touchstart.prevent="startResize" />
    <div class="terminal-header">
      <TerminalTabs
        :tabs="visibleTabs"
        :active-id="activeTabId"
        :touch="isTouch"
        @switch="handleSwitch"
        @close="handleCloseTab"
        @create="handleCreate"
      />
      <button
        v-if="isTouch"
        class="terminal-header-btn"
        :aria-label="keyBarVisible ? '隐藏按键条' : '显示按键条'"
        :title="keyBarVisible ? '隐藏按键条' : '显示按键条'"
        @click="toggleKeyBar"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
        </svg>
      </button>
      <button
        v-if="!isTouch"
        class="terminal-header-btn"
        aria-label="搜索终端内容"
        title="搜索终端内容 (Ctrl+F)"
        @click="openSearch"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="15.5" y1="15.5" x2="21" y2="21" />
        </svg>
      </button>
      <button
        v-if="!isTouch"
        class="terminal-header-btn"
        :aria-label="isMaximized ? '还原终端面板' : '最大化终端面板'"
        :title="isMaximized ? '还原终端面板' : '最大化终端面板'"
        @click="toggleMaximize"
      >
        <svg v-if="!isMaximized" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 9V4h5M20 15v5h-5" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4v5H4M15 20v-5h5" />
        </svg>
      </button>
      <button
        class="terminal-panel-close"
        aria-label="关闭终端面板"
        :title="isTouch ? '关闭终端' : '关闭终端 (Ctrl+`)'"
        @click="togglePanel()"
      >
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
      <button class="terminal-search-btn" title="上一个 (Shift+Enter)" aria-label="上一个搜索结果" @click="searchPrevious">↑</button>
      <button class="terminal-search-btn" title="下一个 (Enter)" aria-label="下一个搜索结果" @click="searchNext()">↓</button>
      <button class="terminal-search-btn" title="关闭 (Esc)" aria-label="关闭搜索" @click="closeSearch">✕</button>
    </div>
    <div v-if="activeTakenOver" class="terminal-takeover">
      <span>该终端已在其他窗口接管，此处已停止接收输出。</span>
      <button class="terminal-takeover-btn" @click="handleReattach">重新接管</button>
    </div>
    <div v-if="reconnecting" class="terminal-reconnect-bar" role="status">终端重连中…</div>
    <div class="terminal-container">
      <div
        v-for="tab in visibleTabs"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        :ref="(el) => setContainerRef(tab.id, el as HTMLElement | null)"
        class="terminal-instance"
      />
      <div v-if="visibleTabs.length === 0" class="terminal-empty">当前任务没有终端，点击 + 新建</div>
      <button
        v-if="!atBottom"
        type="button"
        class="terminal-scroll-bottom"
        :class="{ 'has-new': hasNewOutput }"
        aria-label="回到底部"
        title="回到底部"
        @click="scrollToBottom"
      >
        <span aria-hidden="true">↓</span>
        <span v-if="hasNewOutput" class="terminal-scroll-dot" />
      </button>
      <TerminalCopyOverlay
        v-if="copyOverlayVisible"
        :text="copyText"
        :font-family="copyFontFamily"
        :font-size="copyFontSize"
        :line-height="copyLineHeight"
        :letter-spacing="copyLetterSpacing"
        :initial-scroll-top="copyScrollTop"
        :alternate="copyAlternate"
        @copy="copySnapshot"
        @close="closeCopyOverlay"
      />
    </div>
    <TerminalKeyBar
      v-if="isOpen && isTouch && keyBarVisible"
      :ctrl-state="ctrl"
      :alt-state="alt"
      @key="handleKeySend"
      @action="handleKeyAction"
    />
    <el-dialog
      v-model="pasteDialogVisible"
      title="粘贴到终端"
      width="90%"
      top="8vh"
      class="terminal-paste-dialog"
    >
      <textarea
        ref="pasteInputRef"
        v-model="pasteText"
        class="terminal-paste-textarea"
        rows="4"
        placeholder="长按此处调出系统菜单粘贴，然后点「发送」"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
      />
      <div class="terminal-paste-actions">
        <button type="button" class="terminal-paste-btn" @click="pasteDialogVisible = false">取消</button>
        <button type="button" class="terminal-paste-btn primary" @click="confirmPasteDialog">发送</button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useTerminal, TERMINAL_PANEL_STATE_KEY } from '../../composables/useTerminal'
import { useTerminalModifiers } from '../../composables/useTerminalModifiers'
import { useTerminalWS } from '../../composables/useTerminalWS'
import { useSessionStore } from '../../stores/session'
import { isTouchTerminal } from '../../utils/terminal-touch'
import { encodeKey, type KeyBarAction, type KeyId } from '../../utils/terminal-keys'
import { extractBufferText } from '../../utils/terminal-buffer-text'
import TerminalTabs from './TerminalTabs.vue'
import TerminalKeyBar from './TerminalKeyBar.vue'
import TerminalCopyOverlay from './TerminalCopyOverlay.vue'

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
  adjustFontSize,
  sendRaw,
  switchTab,
  closeTerminal,
  togglePanel,
  getActiveInstance,
  getInstance,
  fontSize,
} = useTerminal()

const { ctrl, alt, toggleCtrl, toggleAlt, reset: resetModifiers } = useTerminalModifiers()
const terminalWS = useTerminalWS()
const sessionStore = useSessionStore()

const isTouch = isTouchTerminal()

const panelRef = ref<HTMLElement | null>(null)
const MIN_HEIGHT = 100
const MAX_HEIGHT_RATIO = 0.7
const HEIGHT_KEY = 'mao_terminal_panel_height'
const KEYBAR_KEY = 'mao_terminal_keybar_visible'

function readStoredNumber(key: string): number | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const value = localStorage.getItem(key)
    return value == null ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // 隐私模式 / 存储满：不影响本次交互
  }
}

/** 面板可用高度：可视高度减去顶栏与连接横幅，留 8px 呼吸。 */
function computeMaxHeight(): number {
  if (typeof window === 'undefined') return 600
  const viewportH = window.visualViewport?.height ?? window.innerHeight
  const nav = document.querySelector('.top-nav')?.getBoundingClientRect().height ?? 0
  const banner = document.querySelector('.connection-banner')?.getBoundingClientRect().height ?? 0
  return Math.max(MIN_HEIGHT, Math.round(viewportH - nav - banner - 8))
}

const maxHeight = ref(computeMaxHeight())
const storedHeight = isTouch ? readStoredNumber(HEIGHT_KEY) : null
const panelHeight = ref(
  isTouch
    ? (storedHeight != null && storedHeight >= MIN_HEIGHT ? Math.round(storedHeight) : 0)
    : 300,
)
const isMaximized = ref(false)
let preMaximizeHeight = 0

const effectiveHeight = computed(() => {
  const max = maxHeight.value
  if (isMaximized.value) return Math.max(MIN_HEIGHT, max)
  if (!isTouch) return Math.max(MIN_HEIGHT, Math.min(panelHeight.value, max))
  const desired = panelHeight.value > 0 ? panelHeight.value : Math.round(max * 0.5)
  return Math.max(MIN_HEIGHT, Math.min(desired, max))
})

const keyBarVisible = ref(readStoredBoolean(KEYBAR_KEY, true))

const reconnecting = computed(
  () => isOpen.value
    && visibleTabs.value.some((tab) => tab.mode === 'remote')
    && !terminalWS.connected.value,
)

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

/* ---------------- 面板高度 / 软键盘避让 ---------------- */

let fitTimer: ReturnType<typeof setTimeout> | null = null
let lastFitAt = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** 软键盘是否展开：只看高度差，候选栏 / 输入时的 visualViewport 抖动不算。 */
let keyboardOpen = false

function isKeyboardOpen(): boolean {
  const vv = window.visualViewport
  if (!vv) return false
  return window.innerHeight - vv.height > Math.min(160, window.innerHeight * 0.25)
}

/** 拖动面板等连续操作：100ms 节流 fit，让内容跟手。 */
function queueFit(): void {
  if (fitTimer != null) return
  const wait = Math.max(0, 100 - (Date.now() - lastFitAt))
  fitTimer = setTimeout(() => {
    fitTimer = null
    lastFitAt = Date.now()
    if (activeTabId.value) fitTerminal(activeTabId.value)
  }, wait)
}

/** 视口变化：去抖 250ms，等键盘 / 地址栏动画停下来再算一次，避免中途反复 resize PTY。 */
function debouncedFit(): void {
  if (debounceTimer != null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    lastFitAt = Date.now()
    if (activeTabId.value) fitTerminal(activeTabId.value)
  }, 250)
}

function handleViewportChange(): void {
  const vv = window.visualViewport
  const panel = panelRef.value
  if (vv && panel) {
    const occluded = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
    panel.style.marginBottom = occluded > 0 ? `${occluded}px` : ''
  }
  // 只有软键盘真正开合才重算面板可用高度并重排 PTY。输入法候选栏、输入时 vv 的
  // 细微抖动若也触发 fit，服务端 shell 会反复收到 SIGWINCH 重绘提示符，用户看到
  // 的就是「输入第二个字符跳到下一行」。
  const open = isKeyboardOpen()
  if (open === keyboardOpen) return
  keyboardOpen = open
  maxHeight.value = computeMaxHeight()
  debouncedFit()
}

function handleWindowResize(): void {
  if (isTouch) {
    // 横竖屏切换等窗口级变化：键盘状态与可用高度都重算，再补一次 fit。
    // 键盘只会触发 visualViewport 事件，不会走这里，所以这里可以放心重排。
    keyboardOpen = isKeyboardOpen()
    maxHeight.value = computeMaxHeight()
    handleViewportChange()
    debouncedFit()
    return
  }
  maxHeight.value = computeMaxHeight()
  if (isMaximized.value) queueFit()
  else fitAllTerminals()
}

function toggleMaximize(): void {
  // 最大化前重新量一次：连接横幅可能刚出现，setup 时算的可用高度会偏大
  maxHeight.value = computeMaxHeight()
  if (isMaximized.value) {
    isMaximized.value = false
    if (panelHeight.value > maxHeight.value) {
      panelHeight.value = preMaximizeHeight > 0 ? preMaximizeHeight : Math.round(maxHeight.value * 0.5)
    }
  } else {
    preMaximizeHeight = panelHeight.value
    isMaximized.value = true
  }
  if (isTouch && panelHeight.value === 0) panelHeight.value = Math.round(maxHeight.value * 0.5)
  nextTick(() => queueFit())
}

function toggleKeyBar(): void {
  keyBarVisible.value = !keyBarVisible.value
  writeStorage(KEYBAR_KEY, String(keyBarVisible.value))
  nextTick(() => queueFit())
}

function startResize(e: MouseEvent | TouchEvent) {
  e.preventDefault()
  const touch = 'touches' in e ? e.touches[0] : null
  const startY = touch ? touch.clientY : (e as MouseEvent).clientY
  const startHeight = effectiveHeight.value

  function applyResize(clientY: number) {
    const delta = startY - clientY
    const max = isTouch ? maxHeight.value : Math.min(window.innerHeight * MAX_HEIGHT_RATIO, maxHeight.value)
    const next = Math.max(MIN_HEIGHT, Math.min(max, startHeight + delta))
    isMaximized.value = false
    panelHeight.value = next
    queueFit()
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
    document.removeEventListener('touchcancel', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (isTouch) writeStorage(HEIGHT_KEY, String(Math.round(panelHeight.value)))
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('touchmove', onTouchMove, { passive: true })
  document.addEventListener('touchend', onUp)
  document.addEventListener('touchcancel', onUp)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

/* ---------------- 回到底部 ---------------- */

const atBottom = ref(true)
const hasNewOutput = ref(false)
let scrollDisposer: (() => void) | null = null
let writeParsedDisposer: (() => void) | null = null
let scrollFrame: number | null = null

function subscribeScrollState(): void {
  scrollDisposer?.()
  writeParsedDisposer?.()
  scrollDisposer = null
  writeParsedDisposer = null
  if (scrollFrame != null) {
    cancelAnimationFrame(scrollFrame)
    scrollFrame = null
  }
  const inst = getActiveInstance()
  if (!inst) {
    atBottom.value = true
    hasNewOutput.value = false
    return
  }
  const update = () => {
    const buffer = inst.terminal.buffer.active
    const bottom = buffer.viewportY >= buffer.baseY
    atBottom.value = bottom
    if (bottom) hasNewOutput.value = false
  }
  // 惯性滚动期间 onScroll 每帧触发，写 Vue ref 会连带重渲染按钮；合并到一帧一次
  const scheduleUpdate = () => {
    if (scrollFrame != null) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null
      update()
    })
  }
  const scrollSub = inst.terminal.onScroll(scheduleUpdate)
  const writeSub = inst.terminal.onWriteParsed(() => {
    if (!atBottom.value) hasNewOutput.value = true
  })
  scrollDisposer = () => {
    scrollSub.dispose()
    if (scrollFrame != null) {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = null
    }
  }
  writeParsedDisposer = () => writeSub.dispose()
  update()
}

function scrollToBottom(): void {
  getActiveInstance()?.terminal.scrollToBottom()
}

/* ---------------- 按键条 ---------------- */

function handleKeySend(id: KeyId): void {
  const inst = getActiveInstance()
  const decCkm = inst?.terminal.modes.applicationCursorKeysMode ?? false
  sendRaw(encodeKey(id, decCkm, { ctrl: ctrl.value !== 'off', alt: alt.value !== 'off' }))
}

function toggleSoftKeyboard(): void {
  const inst = getActiveInstance()
  if (!inst) return
  // 焦点可能在终端隐藏 textarea，也可能在搜索框：统一按「当前有可编辑元素聚焦」判断
  const active = document.activeElement as HTMLElement | null
  const editable = active != null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
  if (editable) {
    active.blur()
    return
  }
  inst.terminal.focus()
}

function handleKeyAction(action: KeyBarAction | 'ctrl' | 'alt'): void {
  switch (action) {
    case 'ctrl':
      toggleCtrl()
      return
    case 'alt':
      toggleAlt()
      return
    case 'keyboard':
      toggleSoftKeyboard()
      return
    case 'paste':
      void handlePaste()
      return
    case 'select-text':
      openCopyOverlay()
      return
    case 'search':
      openSearch()
      return
    case 'font-down':
      adjustFontSize(-1)
      return
    case 'font-up':
      adjustFontSize(1)
      return
    case 'maximize':
      toggleMaximize()
      return
    case 'hide-keybar':
      keyBarVisible.value = false
      writeStorage(KEYBAR_KEY, 'false')
      nextTick(() => queueFit())
  }
}

/* ---------------- 粘贴 ---------------- */

const pasteDialogVisible = ref(false)
const pasteText = ref('')
const pasteInputRef = ref<HTMLTextAreaElement | null>(null)

watch(pasteDialogVisible, (open) => {
  if (open) nextTick(() => pasteInputRef.value?.focus())
})

async function handlePaste(): Promise<void> {
  if (!getActiveInstance()) return
  let text: string | null = null
  try {
    text = await navigator.clipboard.readText()
  } catch {
    // Android WebView 常因 clipboard-read 权限被拒：走长按系统菜单的兜底对话框
    text = null
  }
  if (text == null) {
    pasteText.value = ''
    pasteDialogVisible.value = true
    return
  }
  await pasteIntoTerminal(text)
}

async function pasteIntoTerminal(text: string): Promise<void> {
  const inst = getActiveInstance()
  if (!inst || text === '') return
  if (/[\r\n]/.test(text) && !inst.terminal.modes.bracketedPasteMode) {
    // 末尾换行不算额外一行：`cmd\n` 是 1 行命令，不是 2 行
    const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).length
    try {
      await ElMessageBox.confirm(
        `将粘贴 ${lines} 行，每行会立即执行。`,
        '粘贴多行到终端',
        { type: 'warning', confirmButtonText: '仍要粘贴', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  // terminal.paste 内部走 triggerDataEvent → onData，会经过 applyModifiers；
  // 先清掉粘滞修饰键，避免粘贴文本首字母被转成控制字符。
  resetModifiers()
  inst.terminal.paste(text)
}

async function confirmPasteDialog(): Promise<void> {
  const text = pasteText.value
  pasteDialogVisible.value = false
  await pasteIntoTerminal(text)
}

/* ---------------- 选择文本（复制快照） ---------------- */

const copyOverlayVisible = ref(false)
const copyText = ref('')
const copyScrollTop = ref(0)
const copyFontFamily = ref('Menlo, Monaco, "Courier New", monospace')
const copyFontSize = ref(fontSize.value)
const copyLineHeight = ref(1.2)
const copyLetterSpacing = ref(0.3)
const copyAlternate = ref(false)

function openCopyOverlay(): void {
  const inst = getActiveInstance()
  if (!inst) return
  const snapshot = extractBufferText(inst.terminal.buffer, 2000)
  const options = inst.terminal.options
  copyText.value = snapshot.text
  copyFontFamily.value = options.fontFamily ?? copyFontFamily.value
  copyFontSize.value = options.fontSize ?? fontSize.value
  copyLineHeight.value = options.lineHeight ?? 1.2
  copyLetterSpacing.value = options.letterSpacing ?? 0
  const lineHeightPx = copyFontSize.value * copyLineHeight.value
  copyScrollTop.value = Math.max(0, snapshot.viewportLogicalLine * lineHeightPx)
  copyAlternate.value = inst.terminal.buffer.active.type === 'alternate'
  copyOverlayVisible.value = true
  const activeElement = document.activeElement as HTMLElement | null
  activeElement?.blur()
}

function closeCopyOverlay(): void {
  copyOverlayVisible.value = false
}

async function copySnapshot(text: string): Promise<void> {
  let copied = false
  try {
    await navigator.clipboard.writeText(text)
    copied = true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    } finally {
      document.body.removeChild(textarea)
    }
  }
  if (copied) {
    ElMessage.success('已复制')
  } else {
    ElMessage.warning('复制失败，请长按选择后手动复制')
  }
}

/* ---------------- 终端内搜索（Ctrl+F / 头部按钮 / 按键条） ---------------- */

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
  // 触屏端关搜索栏不弹键盘（§4.5）
  if (!isTouch) getActiveInstance()?.terminal.focus()
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

/* ---------------- 面板状态持久化（仅触屏） ---------------- */

interface PanelState {
  sessionId: string
  isOpen: boolean
  activeTabId: string | null
}

function readPanelState(): PanelState | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    const raw = sessionStorage.getItem(TERMINAL_PANEL_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PanelState>
    if (parsed && parsed.isOpen === true && typeof parsed.sessionId === 'string') {
      return {
        sessionId: parsed.sessionId,
        isOpen: true,
        activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
      }
    }
  } catch {
    // 坏记录直接忽略
  }
  return null
}

function persistPanelState(): void {
  if (!isTouch) return
  try {
    if (typeof sessionStorage === 'undefined') return
    const sessionId = sessionStore.activeSessionId
    if (!sessionId) return
    sessionStorage.setItem(TERMINAL_PANEL_STATE_KEY, JSON.stringify({
      sessionId,
      isOpen: isOpen.value,
      activeTabId: activeTabId.value,
    }))
  } catch {
    // 无存储权限时忽略
  }
}

let pendingPanelRestore: PanelState | null = isTouch ? readPanelState() : null

watch(
  () => sessionStore.activeSession,
  (session) => {
    if (!pendingPanelRestore || !session) return
    const state = pendingPanelRestore
    if (session.id !== state.sessionId) {
      pendingPanelRestore = null
      return
    }
    pendingPanelRestore = null
    void (async () => {
      isOpen.value = true
      await restoreRemoteTabs(state.sessionId)
      if (state.activeTabId && visibleTabs.value.some((t) => t.id === state.activeTabId)) {
        activeTabId.value = state.activeTabId
      }
    })()
  },
  { immediate: true },
)

watch([isOpen, activeTabId, () => sessionStore.activeSessionId], persistPanelState)

/* ---------------- tab / 面板生命周期 ---------------- */

function handleCreate() {
  const session = sessionStore.activeSession
  let cwd: string | undefined
  if (session?.executionMode === 'LOCAL' && session.workspace) {
    cwd = session.workspace
  }
  void createTerminal(cwd)
}

function handleSwitch(id: string) {
  switchTab(id)
}

async function handleCloseTab(id: string) {
  if (isTouch) {
    try {
      await ElMessageBox.confirm(
        '关闭后该终端内的进程会被结束。',
        '关闭终端',
        { type: 'warning', confirmButtonText: '关闭', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  await closeTerminal(id)
}

/** 当前 tab 是否被其他窗口接管（需用户手动重新接管）。 */
const activeTakenOver = computed(() => activeTabId.value != null && takenOverTabs.value.includes(activeTabId.value))

function handleReattach() {
  if (activeTabId.value) reattachRemoteTerminal(activeTabId.value)
}

watch(activeTabId, (newId, oldId) => {
  // 修饰键只对当前终端有意义，切走后复位，避免锁定态串到另一个终端
  resetModifiers()
  closeCopyOverlay()
  if (searchVisible.value) {
    if (oldId) clearDecorations(oldId)
    subscribeSearchResults()
    searchNext(true)
  }
  if (!newId) return
  nextTick(() => {
    const container = containerRefs.get(newId)
    if (container && !mountedTerminals.has(newId)) {
      mountedTerminals.add(newId)
      mountTerminal(newId, container)
    } else if (!isTouch) {
      const inst = getActiveInstance()
      if (inst) inst.terminal.focus()
    }
    fitTerminal(newId)
    subscribeScrollState()
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
      subscribeScrollState()
    })
  },
)

/** 切任务：解绑旧任务终端（让后端能按 idle 回收），再与后端对齐当前任务的 tab。
 *  LOCAL 的中继终端同样带 sessionId（技术方案 2026-11-18 §4.4），解绑 / 对齐规则与 CLOUD 相同。 */
watch(() => sessionStore.activeSessionId, async () => {
  closeSearch()
  closeCopyOverlay()
  pasteDialogVisible.value = false
  resetModifiers()
  const session = sessionStore.activeSession
  detachRemoteTerminals(session ? session.id : null)
  if (isOpen.value && session && (session.executionMode === 'CLOUD' || session.executionMode === 'LOCAL')) {
    await restoreRemoteTabs(session.id)
  }
  if (!activeTabId.value || !visibleTabs.value.some((t) => t.id === activeTabId.value)) {
    activeTabId.value = visibleTabs.value[0]?.id ?? null
  }
  subscribeScrollState()
})

watch(isOpen, async (open) => {
  if (!open) {
    closeSearch()
    closeCopyOverlay()
    pasteDialogVisible.value = false
    resetModifiers()
    return
  }
  if (isTouch && panelHeight.value === 0) panelHeight.value = Math.round(maxHeight.value * 0.5)
  keyboardOpen = isKeyboardOpen()
  maxHeight.value = computeMaxHeight()
  handleViewportChange()
  debouncedFit()
  const session = sessionStore.activeSession
  if (session && (session.executionMode === 'CLOUD' || session.executionMode === 'LOCAL')) {
    await restoreRemoteTabs(session.id)
  }
  nextTick(() => subscribeScrollState())
})

onMounted(() => {
  maxHeight.value = computeMaxHeight()
  window.addEventListener('resize', handleWindowResize)
  document.addEventListener('keydown', handleSearchKeydown)
  if (isTouch) {
    // visualViewport 桌面也存在，仅触屏注册（桌面缩放不该触发键盘避让）
    window.visualViewport?.addEventListener('resize', handleViewportChange)
    window.visualViewport?.addEventListener('scroll', handleViewportChange)
    keyboardOpen = isKeyboardOpen()
    handleViewportChange()
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
  document.removeEventListener('keydown', handleSearchKeydown)
  if (isTouch) {
    window.visualViewport?.removeEventListener('resize', handleViewportChange)
    window.visualViewport?.removeEventListener('scroll', handleViewportChange)
  }
  if (fitTimer != null) {
    clearTimeout(fitTimer)
    fitTimer = null
  }
  if (debounceTimer != null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  scrollDisposer?.()
  writeParsedDisposer?.()
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

.terminal-header-btn {
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
  padding: 0;
  transition: color 0.15s, background 0.15s;
}

.terminal-header-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-divider-soft);
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
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
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
  position: relative;
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
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: 1px solid var(--aw-primary);
  border-radius: 4px;
  background: transparent;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.terminal-takeover-btn:hover {
  background: var(--aw-divider-soft);
}

.terminal-reconnect-bar {
  flex-shrink: 0;
  padding: 2px 12px;
  background: var(--aw-terminal-header-bg);
  border-bottom: 1px solid var(--aw-divider-soft);
  color: var(--aw-ink-muted-60);
  font-size: 11px;
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

.terminal-scroll-bottom {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 15;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 50%;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  touch-action: manipulation;
}

.terminal-scroll-bottom.has-new {
  border-color: var(--aw-primary);
  color: var(--aw-primary);
}

.terminal-scroll-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aw-primary);
}

.terminal-paste-textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 14px;
  line-height: 1.4;
  resize: vertical;
  outline: none;
}

.terminal-paste-textarea:focus {
  border-color: var(--aw-primary);
}

.terminal-paste-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.terminal-paste-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 13px;
  cursor: pointer;
}

.terminal-paste-btn.primary {
  border-color: var(--aw-primary);
  color: #fff;
  background: var(--aw-primary);
}
</style>