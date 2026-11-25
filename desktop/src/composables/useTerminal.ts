import { computed, ref, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { ElMessage } from 'element-plus'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { getLocalDeviceId } from '../utils/device-info'
import { isElectronClient } from '../utils/platform'
import { useSessionStore } from '../stores/session'
import { installImeTextareaSweeper, shouldInstallImeSweeper } from '../utils/terminal-ime-guard'
import { installTouchScroll } from '../utils/terminal-touch-scroll'
import { isTouchTerminal } from '../utils/terminal-touch'
import { useTerminalWS, type TerminalAttachedMeta, type TerminalOutputMeta } from './useTerminalWS'
import { useTerminalModifiers } from './useTerminalModifiers'

const DARK_THEME = {
  background: '#26262a',
  foreground: '#d0d0d4',
  cursor: '#ffffff',
  selectionBackground: '#264f78',
  black: '#26262a',
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
  /** local = Electron 本机 PTY；remote = 后端服务器 PTY（CLOUD 任务 / LOCAL 中继终端） */
  mode: 'local' | 'remote'
  /** remote 必填（desktop 侧 Session.id 为 string）；local 为 null */
  sessionId: string | null
  /** 中继终端（技术方案 2026-11-18 §4.4）：PTY 在绑定设备上，观看协议与云端一致 */
  kind?: 'local-relay'
}

interface TerminalInstance {
  terminal: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  mode: 'local' | 'remote'
  disposers: Array<() => void>
  /** WebGL 上下文丢失后的重试状态（每实例只重载一次）。 */
  webglState: { lost: boolean; retried: boolean }
  /** 已写入 xterm 的原始流最后字节序号；null 表示下次 attach 必须全量回放。 */
  lastSeq: number | null
  /** 下一帧应出现的帧首序号；null 表示尚未建立序号基线（全量回放中）。 */
  expectedSeq: number | null
  /** 收到过背压缺口：下次 attach 不带 fromSeq，强制全量回放。 */
  needsFullReplay: boolean
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
  /** 中继终端标记（LOCAL 会话）：观看端据此区分标签 */
  kind?: 'local-relay'
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const FONT_SIZE_KEY = 'mao_terminal_font_size'
export const TERMINAL_PANEL_STATE_KEY = 'mao_terminal_panel_state'
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 18
const DEFAULT_FONT_SIZE = 12

function loadFontSize(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_FONT_SIZE
    const raw = Number(localStorage.getItem(FONT_SIZE_KEY))
    if (!Number.isFinite(raw)) return DEFAULT_FONT_SIZE
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(raw)))
  } catch {
    return DEFAULT_FONT_SIZE
  }
}

/** 与全局令牌 --aw-tracking（0.025em）对齐；xterm 的 letterSpacing 只收 px。 */
function letterSpacingFor(fontSize: number): number {
  return Math.round(fontSize * 0.025 * 100) / 100
}

const terminalFontSize = ref(loadFontSize())
/** 修饰键状态是模块级单例：所有终端实例共用一套粘滞状态。 */
const modifiers = useTerminalModifiers()
let visibilityRetryInitialized = false

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

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? DARK_THEME : LIGHT_THEME
}

/** 本机是否 Electron（缓存到模块级：渲染进程内 electronAPI 的存在性不变）。 */
const isElectron = isElectronClient()

/**
 * 本机是否这条会话的执行端（技术方案 2026-11-18 §4.4）：绑定缺失（存量未登记会话）
 * 按执行端处理。异步 deviceId 缓存在 getLocalDeviceId 里，本函数内同步取缓存值。
 */
/** ref：visibleTabs 是 computed，读 ref 才会在 deviceId 就绪后重新求值（评审 P2-9）。 */
const executorDeviceId = ref<string | null>(null)
if (isElectron) void getLocalDeviceId().then((id) => { executorDeviceId.value = id })

function isExecutorOf(session: { targetDeviceId?: string | null } | null | undefined): boolean {
  if (!isElectron) return false
  const bound = session?.targetDeviceId
  if (bound == null || bound === '') return true
  return bound === executorDeviceId.value
}

/**
 * 当前任务下应展示的 tab（技术方案 2026-11-18 §4.4）：
 * - CLOUD：本任务的云端终端（不含中继）。
 * - LOCAL 本机是执行端：全部 IPC 本机标签 + 该会话的中继标签。
 * - LOCAL 其它客户端：只显示该会话的中继标签（收掉双机看错机器的本机标签）。
 */
const visibleTabs = computed<TerminalTab[]>(() => {
  const session = useSessionStore().activeSession
  if (session?.executionMode === 'CLOUD') {
    return tabs.value.filter((t) => t.mode === 'remote' && t.sessionId === session.id && t.kind !== 'local-relay')
  }
  if (session && session.executionMode === 'LOCAL') {
    const relayOfSession = (t: TerminalTab) => t.mode === 'remote' && t.kind === 'local-relay' && t.sessionId === session.id
    if (isExecutorOf(session)) {
      return tabs.value.filter((t) => (t.mode === 'local' && t.sessionId == null) || relayOfSession(t))
    }
    return tabs.value.filter(relayOfSession)
  }
  // 无活跃会话：维持旧行为（本机标签）
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
    if (electronListenersInitialized || !isElectron) return
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
  function buildTerminal(): {
    terminal: Terminal
    fitAddon: FitAddon
    searchAddon: SearchAddon
    webglState: { lost: boolean; retried: boolean }
  } {
    initVisibilityRetry()
    const fontSize = terminalFontSize.value
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      // 与全局令牌 --aw-tracking（style.css）的 0.025em 对齐；改字号时同步换算
      letterSpacing: letterSpacingFor(fontSize),
      lineHeight: 1.2,
      scrollback: 5000,
      theme: currentTheme(),
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)

    const webglState = { lost: false, retried: false }
    // Load WebGL renderer for better selection accuracy
    try {
      const webgl = new WebglAddon()
      // 上下文丢失（GPU 重置/驱动故障、安卓切后台）时释放 WebGL 渲染器，xterm 自动回落 DOM 渲染；
      // 回前台时由 initVisibilityRetry 尝试重载一次（见 retryWebgl）
      webgl.onContextLoss(() => {
        webglState.lost = true
        webgl.dispose()
      })
      terminal.loadAddon(webgl)
    } catch {
      // WebGL not supported, fall back to canvas renderer
    }
    return { terminal, fitAddon, searchAddon, webglState }
  }

  /** WebGL 上下文丢失后回到前台只重试一次；失败就始终用 DOM 渲染。 */
  function retryWebgl(inst: TerminalInstance): void {
    if (!inst.webglState.lost || inst.webglState.retried) return
    inst.webglState.retried = true
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        inst.webglState.lost = true
        webgl.dispose()
      })
      inst.terminal.loadAddon(webgl)
      inst.webglState.lost = false
    } catch {
      // 放弃：本实例生命周期内不再尝试
    }
  }

  function initVisibilityRetry(): void {
    if (visibilityRetryInitialized) return
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    visibilityRetryInitialized = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      for (const [, inst] of instances) retryWebgl(inst)
    })
  }

  /** 原始通道：按键条 / 触摸滚动用，不经过 onData 的修饰键处理。 */
  function writeInstance(id: string, inst: TerminalInstance, data: string): void {
    if (data === '') return
    if (inst.mode === 'local') {
      window.electronAPI.terminal.write(id, data)
    } else {
      terminalWS.sendInput(id, data)
    }
  }

  async function createLocalTerminal(cwd?: string): Promise<string | null> {
    if (!isElectron) return null
    initListeners()

    const result = await window.electronAPI.terminal.create({ cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    const id = result.id
    const { terminal, fitAddon, searchAddon, webglState } = buildTerminal()

    const dataDisposer = terminal.onData((data) => {
      const output = modifiers.applyModifiers(data)
      if (output !== '') window.electronAPI.terminal.write(id, output)
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
      webglState,
      lastSeq: null,
      expectedSeq: null,
      needsFullReplay: false,
    })

    const shellName = result.shell.split('/').pop() || 'zsh'
    tabs.value.push({ id, title: shellName, cwd: cwd || '~', mode: 'local', sessionId: null })
    activeTabId.value = id

    return id
  }

  /** 增量回放：根据 attached / output 帧维护本地的序号基线。 */
  function applyRemoteOutput(inst: TerminalInstance, data: string, meta?: TerminalOutputMeta): void {
    if (meta && typeof meta.seq === 'number' && typeof meta.endSeq === 'number') {
      if (inst.expectedSeq != null && meta.seq !== inst.expectedSeq) {
        // 背压丢帧（或服务端补发不连续）：本地内容已有缺口，下次 attach 强制全量
        inst.needsFullReplay = true
        inst.lastSeq = null
      }
      inst.expectedSeq = meta.endSeq
      if (!inst.needsFullReplay) inst.lastSeq = meta.endSeq
    }
    inst.terminal.write(data)
  }

  function handleAttached(inst: TerminalInstance, meta?: TerminalAttachedMeta): void {
    if ((meta?.replay ?? 'full') === 'full') {
      // 全量回放前清屏，避免与已显示内容重复。用 RIS（ESC c）而非 reset()：
      // 清屏要排在写队列里，否则清不掉尚未落屏的上一段回放。
      inst.terminal.write('\x1bc')
      inst.lastSeq = null
      inst.expectedSeq = null
      inst.needsFullReplay = false
      return
    }
    // 增量：回放帧的帧首序号应等于上次写到的位置；空回放时没有 output 帧，
    // 下一次实时帧从同一位置继续，基线不变。
    inst.expectedSeq = inst.lastSeq
  }

  /** 把后端已存在的终端接入前端（新建与恢复共用）。 */
  function adoptRemoteTerminal(info: RemoteTerminalInfo, sessionId: string): string {
    initThemeListener()
    const id = info.terminalId
    const { terminal, fitAddon, searchAddon, webglState } = buildTerminal()

    const inst: TerminalInstance = {
      terminal,
      fitAddon,
      searchAddon,
      mode: 'remote',
      disposers: [],
      webglState,
      lastSeq: null,
      expectedSeq: null,
      needsFullReplay: false,
    }

    const dataDisposer = terminal.onData((data) => {
      const output = modifiers.applyModifiers(data)
      if (output !== '') terminalWS.sendInput(id, output)
    })
    const resizeDisposer = terminal.onResize(({ cols, rows }) => {
      terminalWS.sendResize(id, cols, rows)
    })
    inst.disposers.push(() => dataDisposer.dispose(), () => resizeDisposer.dispose())

    // 先登记实例再 attach：onOutput 闭包和 attach 的成功回调都要拿到稳定的 inst
    instances.set(id, inst)

    terminalWS.registerTerminal(id, {
      onOutput: (data, meta) => applyRemoteOutput(inst, data, meta),
      onAttached: (_cols, _rows, meta) => {
        handleAttached(inst, meta)
        clearTakenOver(id)
      },
      onExit: () => removeTab(id),
      getResumeSeq: () => (inst.needsFullReplay ? null : inst.lastSeq),
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
    tabs.value.push({ id, title: shellName, cwd: info.cwd, mode: 'remote', sessionId, kind: info.kind })
    return id
  }

  /** attach 并处理失败：失败时在终端内提示，避免「tab 在但无输出」的静默故障。 */
  function attachRemote(id: string): void {
    const inst = instances.get(id)
    // 背压缺口过就强制全量；否则带上最后写入的原始序号做增量回放
    const fromSeq = inst && !inst.needsFullReplay ? inst.lastSeq : null
    void terminalWS.attach(id, { fromSeq }).then(() => {
      const current = instances.get(id)
      if (current) terminalWS.sendResize(id, current.terminal.cols, current.terminal.rows)
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

  /** 统一入口：CLOUD 走云端；LOCAL 本机是执行端走 IPC，其它客户端走中继（§4.4）。 */
  async function createTerminal(cwd?: string): Promise<string | null> {
    const session = useSessionStore().activeSession
    if (!session) return createLocalTerminal(cwd)
    if (session.executionMode === 'CLOUD') {
      return createRemoteTerminal(session.id)
    }
    // 分流前确保 deviceId 缓存就绪：避免启动早期把本机执行端误判成中继端
    if (isElectron) {
      executorDeviceId.value = await getLocalDeviceId()
      if (isExecutorOf(session)) {
        return createLocalTerminal(cwd)
      }
    }
    // 中继创建不传 cwd：cwd 固定用服务端保存的 session.workspace（D10）
    return createRemoteTerminal(session.id)
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
      // textarea 只在 open() 之后存在；移动端输入法会让其累积值被整段重发（见 terminal-ime-guard）
      const textarea = inst.terminal.textarea
      if (textarea && shouldInstallImeSweeper()) {
        inst.disposers.push(installImeTextareaSweeper(textarea))
      }
      // xterm 6.0 没有触摸滚动：触屏端自己补单指滑动 + 双指捏合字号
      if (isTouchTerminal()) {
        inst.disposers.push(installTouchScroll(inst.terminal, {
          sendRaw: (data) => writeInstance(id, inst, data),
          onPinchSteps: (steps) => adjustFontSize(steps),
        }))
      }
    }
    nextTick(() => {
      inst.fitAddon.fit()
      if (inst.mode === 'local') {
        window.electronAPI.terminal.resize(id, inst.terminal.cols, inst.terminal.rows)
      } else {
        terminalWS.sendResize(id, inst.terminal.cols, inst.terminal.rows)
      }
      // 触屏端不自动聚焦：只想看输出时不该被软键盘顶掉半屏
      if (!isTouchTerminal()) inst.terminal.focus()
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

  /** 字号调整（A−/A+ 与双指捏合同一入口）；所有实例共用，改完重新 fit 让 PTY 尺寸跟上。 */
  function adjustFontSize(delta: number): void {
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, terminalFontSize.value + delta))
    if (next === terminalFontSize.value) return
    terminalFontSize.value = next
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(FONT_SIZE_KEY, String(next))
    } catch {
      // 隐私模式下写入可能失败，不影响本次调整
    }
    for (const [, inst] of instances) {
      inst.terminal.options.fontSize = next
      inst.terminal.options.letterSpacing = letterSpacingFor(next)
    }
    fitAllTerminals()
  }

  /**
   * 原始写出通道：按键条 / 触摸滚动用，不经过 terminal.input() → onData → applyModifiers。
   * 用 terminal.input(data, true) 不能绕过（第二个参数只标记用户输入，仍会触发 onData）。
   */
  function sendRaw(data: string): void {
    const id = activeTabId.value
    if (!id) return
    const inst = instances.get(id)
    if (!inst) return
    writeInstance(id, inst, data)
    modifiers.consumeOnce()
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
    } else if (isElectron) {
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

    // 最后一个可见终端被关闭（用户关闭 / 进程退出 / 被回收）后自动收起面板，
    // 避免留下只剩空态提示的终端区域
    if (isOpen.value && visibleTabs.value.length === 0) {
      isOpen.value = false
      detachRemoteTerminals(null)
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
    } else if (session?.executionMode === 'LOCAL') {
      // LOCAL 也对齐后端列表：本机执行端补上中继标签（保留 IPC），其它客户端只回中继（§4.4）
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
    // 触屏端不自动弹键盘（§4.5）；桌面保持原行为
    if (inst && !isTouchTerminal()) nextTick(() => inst.terminal.focus())
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
    modifiers.reset()
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TERMINAL_PANEL_STATE_KEY)
    } catch {
      // 无存储权限时忽略
    }
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
    adjustFontSize,
    sendRaw,
    fontSize: terminalFontSize,
    switchTab,
    closeTerminal,
    togglePanel,
    getActiveInstance,
    getInstance,
    reset,
  }
}
