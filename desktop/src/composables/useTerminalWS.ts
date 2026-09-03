import { ref } from 'vue'
import { getToken } from '../utils/auth-storage'

/**
 * 云端终端 WS 单例：一条连接多路复用多个 terminalId，与 useStreamWS 完全独立。
 * 协议见 docs/plan/cloud-terminal-design-v2.md 7.3：首帧 auth，之后 attach/detach/input/resize/ping。
 */
export interface TerminalHandlers {
  onOutput: (data: string) => void
  onExit?: (exitCode: number) => void
  onError?: (code: string, message: string) => void
  onAttached?: (cols: number, rows: number) => void
}

const SERVER_SILENCE_TIMEOUT_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 10_000
const MAX_RECONNECT_DELAY_MS = 30_000
/** attach 帧发出后等待 attached 回帧的上限。 */
const ATTACH_TIMEOUT_MS = 15_000
/** 等待重连时最多缓冲的待发帧数，超出丢最早的（多为输入按键）。 */
const MAX_PENDING_FRAMES = 200

const connected = ref(false)
let ws: WebSocket | null = null
let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastServerMessageAt = 0
let intentionalClose = false
let connectPromise: Promise<void> | null = null
let pendingSettle: { resolve: () => void; reject: (e: Error) => void; socket: WebSocket } | null = null
/** 已认证（收到 connected 帧）：只有此时才能安全发送业务帧。 */
let authenticated = false
/** 认证完成前 / 断线期间累积的待发帧。 */
let pendingFrames: Array<Record<string, unknown>> = []
/** attach 在途的等待者：收到 attached / error / exit 帧即结束等待，仅超时算失败。 */
const attachWaiters = new Map<string, {
  promise: Promise<void>
  resolve: () => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

/** 期望处于 attach 状态的终端：重连成功后自动重发 attach。 */
const attachedTerminals = new Set<string>()
const handlers = new Map<string, TerminalHandlers>()

function wsUrl(): string {
  const wsBase = import.meta.env.VITE_WS_BASE_URL
    || import.meta.env.VITE_API_BASE_URL?.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/api')
    || 'ws://localhost:9080/api'
  return `${wsBase}/ws/terminal`
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  if (attachedTerminals.size === 0 && handlers.size === 0) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect().catch(() => {})
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
}

/** 认证完成后直接发送；否则入队，等 connected 帧到达再 flush。 */
function send(payload: Record<string, unknown>): void {
  if (authenticated && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
    return
  }
  pendingFrames.push(payload)
  if (pendingFrames.length > MAX_PENDING_FRAMES) dropOldestFrame()
  // 队列非空说明有事要做，确保有连接在建立
  if (!intentionalClose) connect().catch(() => {})
}

/** 队列超限时丢最早的输入类帧；attach 必须保留，否则恢复后只发 input 会被服务端拒。 */
function dropOldestFrame(): void {
  const idx = pendingFrames.findIndex((f) => f.type !== 'attach')
  pendingFrames.splice(idx === -1 ? 0 : idx, 1)
}

function flushPending() {
  if (!authenticated || ws?.readyState !== WebSocket.OPEN) return
  const frames = pendingFrames
  pendingFrames = []
  for (const frame of frames) {
    ws.send(JSON.stringify(frame))
  }
}

function settleAttach(terminalId: string, error?: Error) {
  const waiter = attachWaiters.get(terminalId)
  if (!waiter) return
  attachWaiters.delete(terminalId)
  clearTimeout(waiter.timer)
  // 只有服务端明确回错或等待超时才算失败；本地主动 detach/关闭按成功收尾，避免误报
  if (error) waiter.reject(error)
  else waiter.resolve()
}

function onAuthenticated() {
  // 已认证状态下再收到 connected（服务端对重复 auth 的幂等应答）：只 flush，不重排 attach，
  // 否则会对所有终端重复 attach → 清屏 + 全量回放
  if (authenticated) {
    flushPending()
    return
  }
  authenticated = true
  // 重连后重新绑定所有仍在前端存活的终端（后端 attach 绑在旧 socket 上）；
  // 已排队的 attach 帧去重，避免同一终端连发两次 attach 造成重复回放
  const queued = pendingFrames.filter((f) => f.type !== 'attach')
  pendingFrames = [...[...attachedTerminals].map((terminalId) => ({ type: 'attach', terminalId })), ...queued]
  flushPending()
}

function routeMessage(msg: Record<string, any>) {
  const terminalId = typeof msg.terminalId === 'string' ? msg.terminalId : null
  const handler = terminalId ? handlers.get(terminalId) : undefined
  switch (msg.type) {
    case 'output':
      if (handler && typeof msg.data === 'string') handler.onOutput(msg.data)
      return
    case 'attached':
      if (terminalId) settleAttach(terminalId)
      handler?.onAttached?.(Number(msg.cols) || 80, Number(msg.rows) || 24)
      return
    case 'exit':
      if (terminalId) {
        attachedTerminals.delete(terminalId)
        // 错误详情由 handler 上报，attach 等待方只需结束等待
        settleAttach(terminalId)
      }
      handler?.onExit?.(Number(msg.exitCode) || 0)
      return
    case 'error': {
      const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN'
      const message = typeof msg.message === 'string' ? msg.message : '终端错误'
      // 这些错误意味着后端已不再持有该终端，停止重连时的自动 attach
      if (terminalId && code !== 'BAD_REQUEST') attachedTerminals.delete(terminalId)
      if (terminalId) settleAttach(terminalId)
      if (handler) handler.onError?.(code, message)
      else console.warn('[terminal-ws]', code, message)
      return
    }
    case 'connected':
      onAuthenticated()
      return
    case 'pong':
      return
    default:
      return
  }
}

function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (connectPromise) return connectPromise

  const token = getToken()
  if (!token) return Promise.reject(new Error('No token'))

  const socket = new WebSocket(wsUrl())
  ws = socket
  intentionalClose = false
  authenticated = false

  connectPromise = new Promise<void>((resolve, reject) => {
    pendingSettle = { resolve, reject, socket }
    socket.onopen = () => {
      // 已被新连接或 disconnect() 取代：本轮握手结果作废
      if (socket !== ws) return
      connected.value = true
      reconnectDelay = 1000
      connectPromise = null
      pendingSettle = null
      lastServerMessageAt = Date.now()
      // 只发 auth；业务帧一律等 connected 帧后由 flushPending 发出
      socket.send(JSON.stringify({ type: 'auth', token }))
      stopHeartbeat()
      heartbeatTimer = setInterval(() => {
        // 只操作本轮 socket：避免上一代心跳误关新连接
        if (socket !== ws || socket.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastServerMessageAt > SERVER_SILENCE_TIMEOUT_MS) {
          socket.close()
          return
        }
        socket.send(JSON.stringify({ type: 'ping' }))
      }, HEARTBEAT_INTERVAL_MS)
      resolve()
    }

    socket.onmessage = (event) => {
      if (event.target !== ws) return
      lastServerMessageAt = Date.now()
      let msg: Record<string, any>
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      routeMessage(msg)
    }

    socket.onclose = (event) => {
      if (event.target !== ws) {
        // 旧 socket 迟到关闭：仅在其 Promise 仍在途时就地 settle，避免调用方永久挂起
        if (connectPromise && pendingSettle?.socket === socket) {
          connectPromise = null
          const settle = pendingSettle
          pendingSettle = null
          if (intentionalClose) settle.resolve()
          else settle.reject(new Error('Terminal WebSocket closed'))
        }
        return
      }
      connected.value = false
      authenticated = false
      stopHeartbeat()
      const settle = pendingSettle
      connectPromise = null
      pendingSettle = null
      if (!intentionalClose) {
        scheduleReconnect()
        settle?.reject(new Error('Terminal WebSocket closed'))
      } else {
        settle?.resolve()
      }
    }

    socket.onerror = () => {
      // onclose 随后触发，重连与 reject 都在那里处理
    }
  })

  return connectPromise
}

export function useTerminalWS() {
  function ensureConnected(): Promise<void> {
    intentionalClose = false
    return connect()
  }

  function registerTerminal(terminalId: string, terminalHandlers: TerminalHandlers) {
    handlers.set(terminalId, terminalHandlers)
  }

  function unregisterTerminal(terminalId: string) {
    handlers.delete(terminalId)
    attachedTerminals.delete(terminalId)
    settleAttach(terminalId)
  }

  /** 绑定终端；Promise 在收到 attached 帧、收到错误帧或超时后 settle。 */
  function attach(terminalId: string): Promise<void> {
    // attach 是明确的连线意图：撤销上次 disconnect() 的「不再重连」状态（登出后重新登录）
    intentionalClose = false
    attachedTerminals.add(terminalId)
    const existing = attachWaiters.get(terminalId)
    if (existing) {
      // 已有在途 attach：此时 send 不会被调用，断线期间需自行确保有连接在建立
      if (!authenticated) connect().catch(() => {})
      return existing.promise
    }
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(() => {
      attachWaiters.delete(terminalId)
      reject(new Error('终端连接超时'))
    }, ATTACH_TIMEOUT_MS)
    attachWaiters.set(terminalId, { promise, resolve, reject, timer })
    send({ type: 'attach', terminalId })
    return promise
  }

  /** 解绑但保留前端实例：切走任务时调用，让后端终端进入 idle 计时。 */
  function detach(terminalId: string) {
    if (!attachedTerminals.delete(terminalId)) return
    settleAttach(terminalId)
    // 已入队但未发出的该终端帧不再需要
    pendingFrames = pendingFrames.filter((f) => f.terminalId !== terminalId)
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'detach', terminalId }))
    }
  }

  function sendInput(terminalId: string, data: string) {
    if (!attachedTerminals.has(terminalId)) return
    send({ type: 'input', terminalId, data })
  }

  function sendResize(terminalId: string, cols: number, rows: number) {
    if (!attachedTerminals.has(terminalId)) return
    send({ type: 'resize', terminalId, cols, rows })
  }

  function isAttached(terminalId: string): boolean {
    return attachedTerminals.has(terminalId)
  }

  /** 登出时调用：断开且不再自动重连。 */
  function disconnect() {
    intentionalClose = true
    authenticated = false
    stopHeartbeat()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    attachedTerminals.clear()
    handlers.clear()
    pendingFrames = []
    for (const terminalId of [...attachWaiters.keys()]) {
      settleAttach(terminalId)
    }
    if (ws) {
      ws.close()
      ws = null
    }
    connected.value = false
    reconnectDelay = 1000
    if (connectPromise) {
      connectPromise = null
      const settle = pendingSettle
      pendingSettle = null
      settle?.reject(new Error('Terminal WebSocket cancelled'))
    }
  }

  return {
    connected,
    ensureConnected,
    registerTerminal,
    unregisterTerminal,
    attach,
    detach,
    sendInput,
    sendResize,
    isAttached,
    disconnect,
  }
}
