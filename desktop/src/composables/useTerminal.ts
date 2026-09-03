import { computed, ref, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { ElMessage } from 'element-plus'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useTerminalWS } from './useTerminalWS'

const DARK_THEME = {
  background: '#252525',
  foreground: '#cccccc',
  cursor: '#ffffff',
  selectionBackground: '#264f78',
  black: '#252525',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#d7ba7d',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
}

const LIGHT_THEME = {
  background: '#f5f5f7',
  foreground: '#1d1d1f',
  cursor: '#1d1d1f',
  selectionBackground: '#b3d7fc',
  black: '#1d1d1f',
  red: '#ff3b30',
  green: '#34c759',
  yellow: '#ff9f0a',
  blue: '#0066cc',
  magenta: '#af52de',
  cyan: '#5ac8fa',
  white: '#ffffff',
  brightBlack: '#86868b',
  brightRed: '#ff3b30',
  brightGreen: '#34c759',
  brightYellow: '#ff9f0a',
  brightBlue: '#0066cc',
  brightMagenta: '#af52de',
  brightCyan: '#5ac8fa',
  brightWhite: '#ffffff',
}

export interface TerminalTab {
  id: string
  title: string
  cwd: string
  /** local = Electron 本机 PTY；remote = 后端服务器 PTY（CLOUD 任务） */
  mode: 'local' | 'remote'
  /** remote 必填（desktop 侧 Session.id 为 string）；local 为 null */
  sessionId: string | null
}

interface TerminalInstance {
  terminal: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  mode: 'local' | 'remote'
  disposers: Array<() => void>
}

/** 后端 GET/POST /sessions/{id}/terminals 返回的终端信息。 */
interface RemoteTerminalInfo {
  terminalId: string
  sessionId: number
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

// Module-level singleton state
const tabs = ref<TerminalTab[]>([])
const activeTabId = ref<string | null>(null)
const isOpen = ref(false)
/** 被其他窗口接管、需要用户手动重新接管的远程终端。 */
const takenOverTabs = ref<string[]>([])

const instances = new Map<string, TerminalInstance>()
/** 同一任务的 restoreRemoteTabs 去重（togglePanel 与 watch(isOpen) 会并发触发）。 */
const restoreInflight = new Map<string, Promise<void>>()

let electronListenersInitialized = false
let themeListenerInitialized = false
let themeObserver: MutationObserver | null = null

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? DARK_THEME : LIGHT_THEME
}

/** 当前任务下应展示的 tab：CLOUD 只看本任务的远程终端，LOCAL 只看本地终端。 */
const visibleTabs = computed<TerminalTab[]>(() => {
  const session = useSessionStore().activeSession
  if (session?.executionMode === 'CLOUD') {
    return tabs.value.filter((t) => t.mode === 'remote' && t.sessionId === session.id)
  }
  return tabs.value.filter((t) => t.mode === 'local')
})

export function useTerminal() {
  const terminalWS = useTerminalWS()

  /** 主题监听与本地终端无关，Web/安卓下也要生效，因此与 Electron IPC 监听分开初始化。 */
  function initThemeListener() {
    if (themeListenerInitialized) return
    themeListenerInitialized = true
    themeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'data-theme') {
          const theme = currentTheme()
          for (const [, inst] of instances) {
            inst.terminal.options.theme = theme
          }
          break
        }
      }
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }

  function initListeners() {
    initThemeListener()
    if (electronListenersInitialized || !isElectron()) return
    electronListenersInitialized = true

    window.electronAPI.terminal.onData(
      ({ id, data }: { id: string; data: string }) => {
        const inst = instances.get(id)
        if (inst) {
          inst.terminal.write(data)
        }
      }
    )

    window.electronAPI.terminal.onExit(
      ({ id }: { id: string; exitCode: number }) => {
        removeTab(id)
      }
    )
  }

  /** 建 xterm 实例并装载 fit / webgl / search 插件（local 与 remote 共用）。 */
  function buildTerminal(): { terminal: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: currentTheme(),
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)

    // Load WebGL renderer for better selection accuracy
    try {
      const webgl = new WebglAddon()
      // 上下文丢失（GPU 重置/驱动故障）时释放 WebGL 渲染器，xterm 自动回落 DOM/canvas 渲染
      webgl.onContextLoss(() => {
        webgl.dispose()
      })
      terminal.loadAddon(webgl)
    } catch {
      // WebGL not supported, fall back to canvas renderer
    }
    return { terminal, fitAddon, searchAddon }
  }

  async function createLocalTerminal(cwd?: string): Promise<string | null> {
    if (!isElectron()) return null
    initListeners()

    const result = await window.electronAPI.terminal.create({ cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    const id = result.id
    const { terminal, fitAddon, searchAddon } = buildTerminal()

    const dataDisposer = terminal.onData((data) => {
      window.electronAPI.terminal.write(id, data)
    })
    const resizeDisposer = terminal.onResize(({ cols, rows }) => {
      window.electronAPI.terminal.resize(id, cols, rows)
    })

    instances.set(id, {
      terminal,
      fitAddon,
      searchAddon,
      mode: 'local',
      disposers: [() => dataDisposer.dispose(), () => resizeDisposer.dispose()],
    })

    const shellName = result.shell.split('/').pop() || 'zsh'
    tabs.value.push({ id, title: shellName, cwd: cwd || '~', mode: 'local', sessionId: null })
    activeTabId.value = id

    return id
  }

  /** 把后端已存在的终端接入前端（新建与恢复共用）。 */
  function adoptRemoteTerminal(info: RemoteTerminalInfo, sessionId: string): string {
    initThemeListener()
    const id = info.terminalId
    const { terminal, fitAddon, searchAddon } = buildTerminal()

    const dataDisposer = terminal.onData((data) => {
      terminalWS.sendInput(id, data)
    })
    const resizeDisposer = terminal.onResize(({ cols, rows }) => {
      terminalWS.sendResize(id, cols, rows)
    })

    instances.set(id, {
      terminal,
      fitAddon,
      searchAddon,
      mode: 'remote',
      disposers: [() => dataDisposer.dispose(), () => resizeDisposer.dispose()],
    })

    terminalWS.registerTerminal(id, {
      onOutput: (data) => terminal.write(data),
      onAttached: () => {
        // 每次 attach 服务端都会回放整段缓冲，先清屏避免与已显示内容重复。
        // 用 RIS（ESC c）而非 reset()：清屏要排在写队列里，否则清不掉尚未落屏的上一段回放
        terminal.write('\x1bc')
        clearTakenOver(id)
      },
      onExit: () => removeTab(id),
      onError: (code, message) => {
        if (code === 'TERMINAL_TAKEN_OVER') {
          // 终端被其他窗口接管：保留 tab，提供「重新接管」入口
          markTakenOver(id)
          terminal.write(`\r\n\x1b[33m[${message}，可点击标签栏的「重新接管」继续使用]\x1b[0m\r\n`)
          return
        }
        if (code === 'TERMINAL_RECLAIMED' || code === 'TERMINAL_NOT_FOUND') {
          ElMessage.warning(message)
          removeTab(id)
          return
        }
        if (code === 'TERMINAL_FORBIDDEN') {
          // 多为重连窗口内的过期帧，重连后会自动重新 attach，不打扰用户
          console.warn('[terminal]', code, message)
          return
        }
        ElMessage.error(message)
      },
    })
    attachRemote(id)

    const shellName = info.shell.split('/').pop() || 'bash'
    tabs.value.push({ id, title: shellName, cwd: info.cwd, mode: 'remote', sessionId })
    return id
  }

  /** attach 并处理失败：失败时在终端内提示，避免「tab 在但无输出」的静默故障。 */
  function attachRemote(id: string): void {
    void terminalWS.attach(id).then(() => {
      const inst = instances.get(id)
      if (inst) terminalWS.sendResize(id, inst.terminal.cols, inst.terminal.rows)
    }).catch(() => {
      // 终端已被回收/退出的情况由 onError/onExit 分支处理，这里只覆盖超时等未回帧场景。
      // 断线场景重连后会自动重新 attach；连接正常但未回帧时需用户手动重开面板
      instances.get(id)?.terminal.write('\r\n\x1b[33m[终端连接超时，若未自动恢复请重新打开终端面板]\x1b[0m\r\n')
    })
  }

  function markTakenOver(id: string) {
    if (!takenOverTabs.value.includes(id)) takenOverTabs.value.push(id)
  }

  function clearTakenOver(id: string) {
    const idx = takenOverTabs.value.indexOf(id)
    if (idx !== -1) takenOverTabs.value.splice(idx, 1)
  }

  /** 用户点击「重新接管」：重新 attach，成功后由 onAttached 清除接管标记并回放缓冲。 */
  function reattachRemoteTerminal(id: string) {
    const inst = instances.get(id)
    if (!inst || inst.mode !== 'remote') return
    attachRemote(id)
  }

  async function createRemoteTerminal(sessionId: string): Promise<string | null> {
    const active = activeTabId.value ? instances.get(activeTabId.value) : null
    const cols = active?.terminal.cols ?? DEFAULT_COLS
    const rows = active?.terminal.rows ?? DEFAULT_ROWS
    let info: RemoteTerminalInfo
    try {
      const { data } = await api.post(`/sessions/${sessionId}/terminals`, { cols, rows })
      info = data
    } catch {
      // 错误提示由 api 响应拦截器统一 toast
      return null
    }
    const id = adoptRemoteTerminal(info, sessionId)
    activeTabId.value = id
    return id
  }

  /** 统一入口：按当前任务执行模式分流。 */
  async function createTerminal(cwd?: string): Promise<string | null> {
    const session = useSessionStore().activeSession
    if (session?.executionMode === 'CLOUD') {
      return createRemoteTerminal(session.id)
    }
    return createLocalTerminal(cwd)
  }

  /** 打开面板 / 切任务时与后端对齐 tab：后端有的补建或重绑，本地多出的移除。 */
  function restoreRemoteTabs(sessionId: string): Promise<void> {
    // togglePanel 与面板内的 watch(isOpen) 会同时触发，去重避免并发 adopt 出重复 tab
    const inflight = restoreInflight.get(sessionId)
    if (inflight) return inflight
    const task = doRestoreRemoteTabs(sessionId).finally(() => restoreInflight.delete(sessionId))
    restoreInflight.set(sessionId, task)
    return task
  }

  async function doRestoreRemoteTabs(sessionId: string): Promise<void> {
    const sessionStore = useSessionStore()
    let list: RemoteTerminalInfo[]
    try {
      const { data } = await api.get(`/sessions/${sessionId}/terminals`)
      list = Array.isArray(data) ? data : []
    } catch {
      return
    }
    // 请求返回前用户可能已切走：此时不应把该任务的终端重新 attach（否则它永不进 idle 回收）
    if (sessionStore.activeSessionId !== sessionId) return
    const remoteIds = new Set(list.map((t) => t.terminalId))
    const localTabs = tabs.value.filter((t) => t.mode === 'remote' && t.sessionId === sessionId)
    let reclaimed = 0
    for (const tab of localTabs) {
      if (!remoteIds.has(tab.id)) {
        removeTab(tab.id)
        reclaimed++
      }
    }
    if (reclaimed > 0) ElMessage.warning('终端已被回收')
    for (const info of list) {
      if (instances.has(info.terminalId)) {
        // 已有实例：切回任务或重连后 attach 可能已失效，重新绑定（同连接重复 attach 幂等）
        if (!terminalWS.isAttached(info.terminalId)) attachRemote(info.terminalId)
      } else {
        adoptRemoteTerminal(info, sessionId)
      }
    }
    if (!activeTabId.value || !visibleTabs.value.some((t) => t.id === activeTabId.value)) {
      activeTabId.value = visibleTabs.value[0]?.id ?? null
    }
  }

  /**
   * 解绑当前不该保持连接的远程终端（切走任务 / 关闭面板）。
   * 保留 xterm 实例与 handler，切回时由 restoreRemoteTabs 重新 attach；
   * 后端因此能把它们计入 idle 超时回收，避免配额被长期占用。
   */
  function detachRemoteTerminals(keepSessionId: string | null): void {
    for (const tab of tabs.value) {
      if (tab.mode !== 'remote') continue
      if (keepSessionId != null && tab.sessionId === keepSessionId) continue
      terminalWS.detach(tab.id)
    }
  }

  function mountTerminal(id: string, container: HTMLElement) {
    const inst = instances.get(id)
    if (!inst) return

    const element = inst.terminal.element
    if (element) {
      // 已挂载过：xterm 的 open() 对已有 element 是空操作，切任务后容器被 Vue 卸载重建，
      // 必须手动把原 DOM 迁移到新容器，否则终端区域空白
      if (element.parentElement !== container) container.appendChild(element)
    } else {
      inst.terminal.open(container)
    }
    nextTick(() => {
      inst.fitAddon.fit()
      if (inst.mode === 'local') {
        window.electronAPI.terminal.resize(id, inst.terminal.cols, inst.terminal.rows)
      } else {
        terminalWS.sendResize(id, inst.terminal.cols, inst.terminal.rows)
      }
      inst.terminal.focus()
    })
  }

  function fitTerminal(id: string) {
    const inst = instances.get(id)
    if (!inst) return
    inst.fitAddon.fit()
  }

  function fitAllTerminals() {
    for (const [id] of instances) {
      fitTerminal(id)
    }
  }

  function switchTab(id: string) {
    activeTabId.value = id
  }

  async function closeTerminal(id: string) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab?.mode === 'remote') {
      if (tab.sessionId) {
        try {
          await api.delete(`/sessions/${tab.sessionId}/terminals/${id}`)
        } catch {
          // 后端删除失败也移除本地 tab，避免留下无法操作的僵尸 tab
        }
      }
    } else if (isElectron()) {
      await window.electronAPI.terminal.kill(id)
    }
    removeTab(id)
  }

  function removeTab(id: string) {
    const inst = instances.get(id)
    if (inst) {
      if (inst.mode === 'remote') terminalWS.unregisterTerminal(id)
      inst.disposers.forEach((d) => d())
      inst.terminal.dispose()
      instances.delete(id)
    }
    clearTakenOver(id)

    // 关闭后的激活项要在同一任务的可见 tab 内挑选，因此先记可见列表内的位置
    const visibleIdx = visibleTabs.value.findIndex((t) => t.id === id)
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx !== -1) {
      tabs.value.splice(idx, 1)
    }

    if (activeTabId.value === id) {
      // 只在当前任务可见的 tab 间切换；无可见 tab 时面板显示空状态
      const remaining = visibleTabs.value
      activeTabId.value = remaining.length > 0
        ? remaining[Math.min(Math.max(visibleIdx, 0), remaining.length - 1)].id
        : null
    }
  }

  async function togglePanel(cwd?: string) {
    isOpen.value = !isOpen.value
    const session = useSessionStore().activeSession
    if (!isOpen.value) {
      // 面板收起后不再消费输出：解绑所有远程终端，让后端可按 idle 回收
      detachRemoteTerminals(null)
      return
    }
    if (session?.executionMode === 'CLOUD') {
      await restoreRemoteTabs(session.id)
    }
    if (visibleTabs.value.length === 0) {
      await createTerminal(cwd)
      return
    }
    if (!activeTabId.value || !visibleTabs.value.some((t) => t.id === activeTabId.value)) {
      activeTabId.value = visibleTabs.value[0].id
    }
    const inst = activeTabId.value ? instances.get(activeTabId.value) : null
    if (inst) nextTick(() => inst.terminal.focus())
  }

  function getActiveInstance(): TerminalInstance | null {
    if (!activeTabId.value) return null
    return instances.get(activeTabId.value) || null
  }

  function getInstance(id: string): TerminalInstance | null {
    return instances.get(id) || null
  }

  /** 登出时清空模块级状态，避免重新登录后残留失效 tab。 */
  function reset() {
    for (const [id, inst] of [...instances]) {
      inst.disposers.forEach((d) => d())
      inst.terminal.dispose()
      instances.delete(id)
    }
    restoreInflight.clear()
    tabs.value = []
    takenOverTabs.value = []
    activeTabId.value = null
    isOpen.value = false
  }

  return {
    tabs,
    visibleTabs,
    activeTabId,
    isOpen,
    takenOverTabs,
    createTerminal,
    createLocalTerminal,
    createRemoteTerminal,
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
    reset,
  }
}
