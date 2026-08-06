/**
 * Capacitor 原生 WebSocket 桥接层（仅安卓 APP 生效）。
 *
 * 目标：让 useStreamWS 在安卓平台上用「原生前台服务持有的唯一 WebSocket」替换浏览器
 * WebSocket，业务事件路由（routeEvent）与订阅逻辑完全复用；Web / Electron 零影响。
 *
 * 核心能力：
 * - WebSocket 兼容接口（readyState / send / close / onopen / onmessage / onclose / onerror）
 * - lastAppliedSeq 去重：at-least-once 语义下正常路径无重复；
 *   seq <= lastAppliedSeq 的事件只 ACK 不路由（lastAppliedSeq 仅当前 WebView 生命周期内有效）
 * - 事件按 sequence 串行处理，成功后累计 ACK
 * - trackSessions / untrackSessions / syncSubscriptions（tracked 与 UI 订阅分离）
 * - recovery 协议封装（beginRecovery / completeRestSync / completeRecovery / abortRecovery）
 * - 前台 jsAlive 心跳（10s），告知原生 WebView 存活
 */
export interface WsBridgeEvent {
  data: string
  seq: number
}

export interface RecoverySnapshot {
  active: boolean
  recoveryId: string | null
  replayFrom: number
  watermark: number
  restSyncSessionIds: number[]
  pendingRecoverySessionIds: number[]
}

export interface WsBridge {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: WsBridgeEvent) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
  /** recovery 补放完成（原生发 replayDone） */
  onReplayDone: (() => void) | null
  /** 通知点击跳转（携带 sessionId） */
  onPendingNavigate: ((sessionId: number) => void) | null
  send(data: string): boolean
  /** 可等待发送：原生 socket 确认发送成功才 resolve true；未就绪/被拒 resolve false。 */
  sendAsync(data: string): Promise<boolean>
  /** 等待原生连接 open（CONNECTING 复用场景），超时/关闭 reject。 */
  waitForOpen(timeoutMs: number): Promise<void>
  close(): void
  stopKeepAlive(): Promise<void>
  trackSessions(sessionIds: number[]): Promise<void>
  untrackSessions(sessionIds: number[], reason: string): Promise<void>
  syncSubscriptions(sessionIds: number[]): Promise<void>
  beginRecovery(): Promise<RecoverySnapshot | null>
  waitUntilApplied(seq: number, timeoutMs: number): Promise<void>
  completeRestSync(recoveryId: string, sessionIds: number[]): Promise<void>
  completeRecovery(recoveryId: string): Promise<void>
  abortRecovery(recoveryId: string): Promise<void>
}

export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

// @ts-ignore Capacitor 7 运行时注入
function getPlugin(): any {
  try {
    // @ts-ignore
    return window.Capacitor?.Plugins?.MaoWs ?? null
  } catch {
    return null
  }
}

export function isAndroidCapacitor(): boolean {
  try {
    // @ts-ignore Capacitor 7 运行时注入
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.() && window.Capacitor.getPlatform?.() === 'android'
  } catch {
    return false
  }
}

// 当前活跃的桥实例（useAppResumeSync 通过它驱动 recovery 协议）
let activeBridge: WsBridge | null = null

export function getActiveBridge(): WsBridge | null {
  return activeBridge
}

// 模块级回调（在桥创建前注册，如 useAppResumeSync init；桥创建后自动生效）
let pendingNavigateHandler: ((sessionId: number) => void) | null = null
let replayDoneHandler: (() => void) | null = null

export function setWsBridgeHandlers(handlers: {
  onPendingNavigate?: (sessionId: number) => void
  onReplayDone?: () => void
}) {
  if (handlers.onPendingNavigate) pendingNavigateHandler = handlers.onPendingNavigate
  if (handlers.onReplayDone) replayDoneHandler = handlers.onReplayDone
}

function isElectronClient(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

/** 当前平台是否应使用原生桥（仅安卓 Capacitor 且非 Electron）。 */
export function shouldUseNativeBridge(): boolean {
  return isAndroidCapacitor() && !isElectronClient() && !!getPlugin()
}

/**
 * 创建原生桥（安卓 Capacitor 平台）；非该平台返回 null（调用方走原 WebSocket 路径）。
 */
export function createWsBridge(token: string, wsUrl: string): WsBridge | null {
  if (!shouldUseNativeBridge()) return null
  const bridge = new NativeWsBridge(token, wsUrl)
  activeBridge = bridge
  return bridge
}

class NativeWsBridge implements WsBridge {
  readyState: number = WS_CONNECTING
  onopen: (() => void) | null = null
  private messageHandler: ((ev: WsBridgeEvent) => void) | null = null
  get onmessage(): ((ev: WsBridgeEvent) => void) | null {
    return this.messageHandler
  }
  set onmessage(handler: ((ev: WsBridgeEvent) => void) | null) {
    this.messageHandler = handler
    if (handler && this.queue.length > 0 && !this.processing) {
      this.processing = true
      this.drain()
    }
  }
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  onReplayDone: (() => void) | null = null
  onPendingNavigate: ((sessionId: number) => void) | null = null

  private readonly plugin: any
  private lastAppliedSeq = 0
  private readonly queue: WsBridgeEvent[] = []
  private processing = false
  private jsAliveTimer: ReturnType<typeof setInterval> | null = null
  private listenersRegistered = false
  private closed = false
  /** CONNECTING 复用场景的等待者（waitForOpen） */
  private openWaiters: Array<() => void> = []
  private appliedWaiters: Array<{ seq: number; resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

  constructor(token: string, wsUrl: string) {
    this.plugin = getPlugin()
    this.registerListeners()
    this.plugin.ensureKeepAlive({ token, wsUrl })
    this.jsAliveTimer = setInterval(() => {
      try {
        this.plugin.jsAlive()
      } catch {
        // 忽略
      }
    }, 10_000)
  }

  private registerListeners() {
    if (this.listenersRegistered) return
    this.listenersRegistered = true

    this.plugin.addListener('wsStatus', (info: { status: string; detail?: string }) => {
      if (this.closed) return
      if (info.status === 'open') {
        this.readyState = WS_OPEN
        this.onopen?.()
        // 唤醒 CONNECTING 复用场景的等待者（connect() / recovery / sendReliable）
        const waiters = this.openWaiters
        this.openWaiters = []
        waiters.forEach((w) => w())
      } else if (info.status === 'auth_failed') {
        this.closed = true
        this.readyState = WS_CLOSED
        this.onerror?.({ message: info.detail || 'auth failed' })
        this.onclose?.()
      } else if (info.status === 'close') {
        // 服务端正常关闭：桥进入终态，防止旧实例继续消费事件（避免与新桥双发）
        this.closed = true
        this.readyState = WS_CLOSED
        this.onclose?.()
      } else if (info.status === 'reconnecting') {
        // 原生层正在重连：JS 侧标记 CONNECTING，避免上层误判 OPEN 而静默丢弃发送
        if (this.readyState === WS_OPEN) {
          this.readyState = WS_CONNECTING
        }
      }
    })

    this.plugin.addListener('wsEvent', (data: { seq: number; message: string }) => {
      if (this.closed) return
      this.enqueue({ data: data.message, seq: data.seq })
    })

    this.plugin.addListener('keepAliveStopped', () => {
      if (this.closed) return
      this.closed = true
      this.readyState = WS_CLOSED
      this.onclose?.()
    })

    this.plugin.addListener('replayDone', () => {
      if (this.closed) return
      this.onReplayDone?.()
      replayDoneHandler?.()
    })

    this.plugin.addListener('pendingNavigate', (info: { sessionId: number }) => {
      if (this.closed) return
      if (info && info.sessionId > 0) {
        const sid = Number(info.sessionId)
        this.onPendingNavigate?.(sid)
        pendingNavigateHandler?.(sid)
      }
    })
  }

  /** 串行处理事件：去重 → 路由（onmessage）→ ACK。 */
  private enqueue(ev: WsBridgeEvent) {
    if (this.closed) return
    this.queue.push(ev)
    // 插件监听可能先于 useStreamWS 挂载 onmessage 收到重放事件；必须保留到处理器就绪，
    // 否则事件会被当作已应用而 ACK，界面却永久缺失。
    if (this.messageHandler && !this.processing) {
      this.processing = true
      this.drain()
    }
  }

  private drain() {
    try {
      // 串行（同步循环天然串行）：保证 routeEvent 按 sequence 顺序应用
      while (this.queue.length > 0 && this.messageHandler && !this.closed) {
        const ev = this.queue[0]
        if (ev.seq > 0) {
          // tracked 事件：去重
          if (ev.seq <= this.lastAppliedSeq) {
            this.queue.shift()
            this.ack(ev.seq) // 已应用过：只 ACK 不路由
            continue
          }
          // 只有实际路由成功后才能移出队列、推进水位并 ACK。
          this.messageHandler({ data: ev.data, seq: ev.seq })
          this.queue.shift()
          this.lastAppliedSeq = ev.seq
          this.resolveAppliedWaiters()
          this.ack(ev.seq)
        } else {
          // subscribed 未 tracked 事件（seq=-1）：实时转发，不 ACK
          this.messageHandler({ data: ev.data, seq: -1 })
          this.queue.shift()
        }
      }
    } finally {
      this.processing = false
    }
  }

  private resolveAppliedWaiters() {
    const ready = this.appliedWaiters.filter((waiter) => waiter.seq <= this.lastAppliedSeq)
    this.appliedWaiters = this.appliedWaiters.filter((waiter) => waiter.seq > this.lastAppliedSeq)
    ready.forEach((waiter) => {
      clearTimeout(waiter.timer)
      waiter.resolve()
    })
  }

  waitUntilApplied(seq: number, timeoutMs: number): Promise<void> {
    if (seq <= this.lastAppliedSeq) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter: { seq: number; resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } = {
        seq,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.appliedWaiters = this.appliedWaiters.filter((item) => item !== waiter)
          reject(new Error(`native replay apply timeout at seq ${seq}`))
        }, timeoutMs)
      }
      this.appliedWaiters.push(waiter)
    })
  }

  private ack(seq: number) {
    try {
      this.plugin.ackEvents({ seq })
    } catch {
      // 忽略
    }
  }

  send(data: string): boolean {
    if (this.readyState !== WS_OPEN) {
      console.warn('[ws-bridge] send dropped (not open), readyState=' + this.readyState)
      return false
    }
    try {
      const call = this.plugin.send({ message: data })
      // Capacitor call 是 Promise（@capacitor/core 注入）；拒绝时不再静默吞掉
      if (call && typeof call.then === 'function') {
        call.then(
          () => {},
          () => {
            // 竞态：readyState 检查后原生 socket 恰好断开，业务消息实际未发出
            console.warn('[ws-bridge] native send rejected (ws not open)')
          }
        )
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 可等待发送：await 插件 Promise，原生确认发送成功才返回 true。
   * 覆盖 readyState 检查与原生 socket 断开之间的竞态（发送被拒不会漏报）。
   */
  async sendAsync(data: string): Promise<boolean> {
    if (this.readyState !== WS_OPEN) {
      console.warn('[ws-bridge] sendAsync dropped (not open), readyState=' + this.readyState)
      return false
    }
    try {
      await this.plugin.send({ message: data })
      return true
    } catch {
      console.warn('[ws-bridge] sendAsync rejected (ws not open)')
      return false
    }
  }

  /**
   * 等待原生连接 open（桥处于 CONNECTING / CLOSING 时复用场景）。
   * 连接已 OPEN 立即 resolve；已终态或超时 reject。
   */
  waitForOpen(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.readyState === WS_OPEN) {
        resolve()
        return
      }
      if (this.readyState === WS_CLOSED) {
        reject(new Error('native ws closed'))
        return
      }
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.openWaiters = this.openWaiters.filter((w) => w !== onOpen)
        reject(new Error('native ws connect timeout'))
      }, timeoutMs)
      const onOpen = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.openWaiters = this.openWaiters.filter((w) => w !== onOpen)
        resolve()
      }
      this.openWaiters.push(onOpen)
    })
  }

  /** 退出登录：真正停止原生保活服务（清除订阅/缓冲/认证状态）。 */
  async stopKeepAlive(): Promise<void> {
    this.closed = true
    this.readyState = WS_CLOSED
    if (this.jsAliveTimer) {
      clearInterval(this.jsAliveTimer)
      this.jsAliveTimer = null
    }
    try {
      await this.plugin.stopKeepAlive()
    } catch {
      // 忽略
    }
  }

  /** 安卓平台：close 仅解绑 WebView 层，不停止原生服务（退出登录才 stopKeepAlive）。 */
  close(): void {
    this.closed = true
    this.readyState = WS_CLOSED
    this.messageHandler = null
    this.queue.length = 0
    const waiters = this.appliedWaiters
    this.appliedWaiters = []
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('native ws bridge closed'))
    })
    if (this.jsAliveTimer) {
      clearInterval(this.jsAliveTimer)
      this.jsAliveTimer = null
    }
  }

  async trackSessions(sessionIds: number[]): Promise<void> {
    await this.plugin.trackSessions({ sessionIds })
  }

  async untrackSessions(sessionIds: number[], reason: string): Promise<void> {
    await this.plugin.untrackSessions({ sessionIds, reason })
  }

  async syncSubscriptions(sessionIds: number[]): Promise<void> {
    await this.plugin.syncSubscriptions({ sessionIds })
  }

  async beginRecovery(): Promise<RecoverySnapshot | null> {
    const snap = await this.plugin.beginRecovery()
    if (!snap || !snap.active) return null
    return {
      active: true,
      recoveryId: snap.recoveryId ?? null,
      replayFrom: Number(snap.replayFrom ?? 1),
      watermark: Number(snap.watermark ?? 0),
      restSyncSessionIds: Array.isArray(snap.restSyncSessionIds) ? snap.restSyncSessionIds.map(Number) : [],
      pendingRecoverySessionIds: Array.isArray(snap.pendingRecoverySessionIds) ? snap.pendingRecoverySessionIds.map(Number) : []
    }
  }

  async completeRestSync(recoveryId: string, sessionIds: number[]): Promise<void> {
    await this.plugin.completeRestSync({ recoveryId, sessionIds })
  }

  async completeRecovery(recoveryId: string): Promise<void> {
    await this.plugin.completeRecovery({ recoveryId })
  }

  async abortRecovery(recoveryId: string): Promise<void> {
    await this.plugin.abortRecovery({ recoveryId })
  }
}
