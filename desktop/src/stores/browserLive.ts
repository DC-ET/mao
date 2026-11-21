import { defineStore } from 'pinia'
import { isElectronClient } from '../utils/platform'
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

export const useBrowserLiveStore = defineStore('browserLive', {
  state: () => ({
    activeSessionId: null as number | null,
    sessions: {} as Record<string, BrowserLiveSessionState>,
    /** 画中画双击放大 → 主窗应打开直播 Tab（TaskView 监听该信号） */
    expandRequested: 0,
    ipcBound: false,
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
    },
    /** 停止浏览器（停止观看不受影响）：LOCAL 走主进程直停 sidecar，CLOUD 由主进程转请 WS。 */
    stopBrowser(sessionId?: number | null) {
      const sid = sessionId ?? this.activeSessionId
      if (sid != null && isElectronClient()) {
        ;(window as any).electronAPI?.browserLive?.stop(sid)
      }
    },
    /** Tab 内「还原画中画」。 */
    restorePip() {
      if (isElectronClient()) (window as any).electronAPI?.browserLive?.restore()
    },
  },
})
