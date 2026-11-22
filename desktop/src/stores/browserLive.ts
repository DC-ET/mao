import { defineStore } from 'pinia'
import { isElectronClient } from '../utils/platform'
import { createBrowserReplayProvider } from '../composables/browserReplayProvider'
import type { BrowserFrameData, BrowserLiveStartedData, BrowserLiveStoppedData } from '@mao/contracts'

/**
 * 浏览器直播状态（方案 2026-11-20 v2 D10）。
 *
 * Electron 下每条 renderer（主窗 / 画中画窗）只吃主进程枢纽一路 IPC（useStreamWS 收到
 * CLOUD 帧后 relayEvent 回灌主进程，不自吃，避免双份）；非 Electron（Web）直接吃
 * useStreamWS 的 WS 帧——Tab 观看在 Web 端自然可用。
 */

export interface BrowserLiveSessionState {
  isLive: boolean
  pageUrl: string
  width: number
  height: number
  cliSession: string
  stoppedReason: string | null
  lastSeq: number
  /** 最新帧的 JPEG base64（只保留最新，旧帧直接覆盖） */
  frame: string | null
}

export interface BrowserLiveEventPayload {
  sessionId: number | null
  type: string
  data?: BrowserLiveStartedData | BrowserFrameData | BrowserLiveStoppedData | Record<string, unknown>
}

function emptySession(): BrowserLiveSessionState {
  return {
    isLive: false, pageUrl: '', width: 0, height: 0,
    cliSession: 'default', stoppedReason: null, lastSeq: 0, frame: null,
  }
}

/** Web 端停止通道注入点：useStreamWS 注册后，stopBrowser 走 WS 帧（Electron 仍走主进程 IPC）。 */
let stopRequester: ((sessionId: number) => void) | null = null

export const useBrowserLiveStore = defineStore('browserLive', {
  state: () => ({
    activeSessionId: null as number | null,
    sessions: {} as Record<string, BrowserLiveSessionState>,
    /** 画中画双击放大 → 主窗应打开直播 Tab（TaskView 监听该信号） */
    expandRequested: 0,
    ipcBound: false,
    /** 无直播时点状态条 chip → 直播 Tab 落在回放列表模式（seq 全局记账、consumedSeq 由视图消费后回写，
     *  记账在 store 而非组件实例：Tab 在 chip 点击后才创建，实例本地基线会吞掉未消费的请求） */
    replayBrowse: { sessionId: null as number | null, seq: 0, consumedSeq: 0 },
    /** 会话是否存在已结算回放（chip 显示条件）；30s 惰性缓存，直播开始/结束即失效 */
    replayAvailability: {} as Record<string, { available: boolean; checkedAt: number }>,
  }),
  getters: {
    activeSession(state): BrowserLiveSessionState | null {
      return state.activeSessionId != null ? state.sessions[String(state.activeSessionId)] ?? null : null
    },
    hasAnyLive(state): boolean {
      return Object.values(state.sessions).some((s) => s.isLive)
    },
  },
  actions: {
    ensure(sessionId: number): BrowserLiveSessionState {
      const key = String(sessionId)
      if (!this.sessions[key]) this.sessions[key] = emptySession()
      return this.sessions[key]
    },
    ingest(msg: BrowserLiveEventPayload) {
      const sessionId = Number(msg.sessionId)
      if (!Number.isFinite(sessionId)) return
      const state = this.ensure(sessionId)
      if (msg.type === 'browser_live_started') {
        const data = msg.data as BrowserLiveStartedData | undefined
        state.isLive = true
        state.stoppedReason = null
        // 新一场直播：host 进程重启后 seq 从 1 重新计数（不清则整场帧被乱序丢弃），
        // 上一场的冻结帧也要清掉，让「等待 Agent 打开浏览器…」占位正常出现
        state.lastSeq = 0
        state.frame = null
        state.width = data?.width ?? 0
        state.height = data?.height ?? 0
        state.pageUrl = data?.pageUrl ?? ''
        state.cliSession = data?.cliSession ?? 'default'
        this.activeSessionId = sessionId
      } else if (msg.type === 'browser_frame') {
        const data = msg.data as BrowserFrameData | undefined
        if (data?.seq != null && data.seq < state.lastSeq) return // 乱序直接丢
        state.lastSeq = data?.seq ?? state.lastSeq
        if (data?.jpeg) state.frame = data.jpeg
        if (data?.pageUrl) state.pageUrl = data.pageUrl
        if (data?.cliSession) state.cliSession = data.cliSession
        this.activeSessionId = sessionId
      } else if (msg.type === 'browser_live_stopped') {
        const data = msg.data as BrowserLiveStoppedData | undefined
        state.isLive = false
        state.stoppedReason = data?.reason ?? 'unknown'
      }
      // 直播状态翻转 → 回放可用性缓存置过期（保留上次结果供 chip 平滑显示，
      // 组件侧 watch isLive 会立即重探，新一场结束后列表才会出现该场）
      if (msg.type === 'browser_live_started' || msg.type === 'browser_live_stopped') {
        this.invalidateReplayAvailability(sessionId)
      }
    },
    /** Electron：绑定主进程枢纽一路（幂等）。App.vue 挂载时调用；画中画窗同样生效。 */
    bindMainProcess() {
      if (this.ipcBound || !isElectronClient()) return
      const api = (window as any).electronAPI?.browserLive
      if (!api?.onEvent) return
      this.ipcBound = true
      api.onEvent((payload: BrowserLiveEventPayload) => this.ingest(payload))
      api.onActiveSession((payload: { sessionId: number | null }) => {
        this.activeSessionId = payload?.sessionId ?? null
      })
      // 初始快照：画中画窗晚于 started 事件创建（showInactive + renderer 加载有延迟），
      // 只吃增量会永远停在等待态（静态页无新帧）；主进程枢纽持有全量状态与最新帧，
      // 挂载即灌入（2026-11-21 Windows 真机 smoke）
      void api.getState?.().then((snapshot: { activeSessionId: number | null; sessions: Record<string, BrowserLiveSessionState> } | null) => {
        if (!snapshot?.sessions) return
        for (const [sessionId, s] of Object.entries(snapshot.sessions)) {
          const state = this.ensure(Number(sessionId))
          Object.assign(state, s, { frame: s.frame ?? state.frame })
          if (s.isLive) this.activeSessionId = Number(sessionId)
        }
        if (snapshot.activeSessionId != null) {
          this.activeSessionId = snapshot.activeSessionId
        }
      })
    },
    /** Web 端注入停止通道（幂等，useStreamWS 调用一次）。 */
    setStopRequester(cb: (sessionId: number) => void) {
      stopRequester = cb
    },
    /** 停止浏览器（停止观看不受影响）：Electron LOCAL 走主进程直停 sidecar，CLOUD 由主进程转请 WS；Web 直接发 WS 帧。 */
    stopBrowser(sessionId?: number | null) {
      const sid = sessionId ?? this.activeSessionId
      if (sid == null) return
      if (isElectronClient()) {
        ;(window as any).electronAPI?.browserLive?.stop(sid)
      } else {
        stopRequester?.(sid)
      }
    },
    /** Tab 内「还原画中画」。 */
    restorePip() {
      if (isElectronClient()) (window as any).electronAPI?.browserLive?.restore()
    },
    /** chip 无直播时点击：直播 Tab 打开后落在回放列表模式（sessionId=null 跟随激活会话）。 */
    requestReplayBrowse(sessionId: number | null) {
      this.replayBrowse = { ...this.replayBrowse, sessionId, seq: this.replayBrowse.seq + 1 }
    },
    /** 视图消费待处理的回放入口请求：取走后回写 consumedSeq，重复调用 / 新挂载实例不会重复消费。 */
    consumeReplayBrowse(): { sessionId: number | null } | null {
      const request = this.replayBrowse
      if (request.seq <= request.consumedSeq) return null
      this.replayBrowse.consumedSeq = request.seq
      return { sessionId: request.sessionId }
    },
    /** 直播状态翻转后置过期：保留上次 available 供 chip 平滑显示，checkedAt=0 触发重探。 */
    invalidateReplayAvailability(sessionId: number) {
      const cached = this.replayAvailability[String(sessionId)]
      this.replayAvailability[String(sessionId)] = { available: cached?.available ?? false, checkedAt: 0 }
    },
    /**
     * 惰性探测当前会话是否已有回放（chip 的「有历史回放」显示条件）。
     * 30s 缓存 + started/stopped 失效；CLOUD 走 API，LOCAL 走主进程 IPC（§4 双路分流）。
     */
    async ensureReplayAvailability(sessionId: number, executionMode: string | null | undefined) {
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return
      const key = String(sessionId)
      const cached = this.replayAvailability[key]
      if (cached && Date.now() - cached.checkedAt < 30_000) return
      this.replayAvailability[key] = { available: cached?.available ?? false, checkedAt: Date.now() }
      const provider = createBrowserReplayProvider(executionMode)
      if (!provider) return
      try {
        const list = await provider.list(sessionId)
        this.replayAvailability[key] = { available: list.length > 0, checkedAt: Date.now() }
      } catch {
        /* 查询失败保留上次结果 */
      }
    },
  },
})
