'use strict'

/**
 * 中继终端主机（技术方案 2026-11-18-local-terminal-remote §4.6）：
 * Electron 主进程作为绑定设备的「终端主机」，连接 /api/ws/terminal-host，替浏览器 /
 * 安卓 / 其它电脑在本机起 PTY。与 IPC 本机终端（terminalManager.cjs）完全分开：
 * 两套 map 互不转发输出，手机上的 shell 不会把字节灌进桌面正在看的本机标签。
 *
 * 协议（§4.5 帧表）：auth → connected(role) → open/opened/open_failed/output/exit
 * 与 input/resize/kill。单帧 UTF-8 ≤256KB；bufferedAmount > 1MB 时丢帧补提示。
 * token 生命周期（§4.5 评审补充）：每次连接（含重连）都从 readAuth() 取最新值；
 * auth-set-tokens 不主动断连，只按 userId 变化杀掉旧账号的 PTY（账号切换 = 登出语义）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')

/** 主机 → 服务器单帧上限：服务器在 /ws/terminal-host 上按 256KB 校验，超限整条按断开处理。 */
const HOST_FRAME_MAX_BYTES = 256 * 1024
/**
 * 数据切片预算：JSON 信封 + 转义（控制字符最坏 6 倍）后仍必须低于 256KB 帧上限——
 * 直接按 256KB 切 data 会让序列化帧超限、被服务器拆连接。与后端 HOST_DATA_CHUNK_BYTES 同值。
 */
const HOST_DATA_CHUNK_BYTES = 32 * 1024
/** 服务器 → 主机的入站信封上限：观看端输入由服务器切片，这里仍兜底防异常帧。 */
const MAX_INBOUND_BYTES = 256 * 1024
/** 服务器 → 观看端的背压阈值与本机 socket 背压阈值。 */
const SOCKET_BACKPRESSURE_BYTES = 1024 * 1024
const DROPPED_NOTICE = '\r\n[输出过快，已丢弃部分内容]\r\n'
const RECONNECT_INITIAL_MS = 1000
const RECONNECT_MAX_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 10_000

/** 按UTF-8 字符边界切片（代理对不拆开），与后端 sliceUtf8 / mao-agent 同口径。 */
function sliceUtf8(text, maxBytes) {
  if (text === '' || maxBytes <= 0) return [text]
  const chunks = []
  let start = 0
  while (start < text.length) {
    let end = start
    let bytes = 0
    while (end < text.length) {
      const code = text.codePointAt(end)
      const size = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1
      if (bytes + size > maxBytes) break
      bytes += size
      end += code > 0xffff ? 2 : 1
    }
    if (end === start) break
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks.length > 0 ? chunks : [text]
}

/** 从 JWT payload 解出 userId（只解不验签：userId 用于账号切换的本地比对，无越权面）。 */
function userIdFromToken(token) {
  if (typeof token !== 'string' || token === '') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const id = Number(payload?.userId)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}

/** 与后端 TerminalManager._detectShell / 桌面 terminalManager 同一条规则。 */
function detectShell(platform) {
  if (process.env.SHELL) return process.env.SHELL
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

function toWsUrl(apiBaseUrl) {
  return `${String(apiBaseUrl || '').replace(/^http/i, 'ws').replace(/\/+$/, '')}/ws/terminal-host`
}

class TerminalHost {
  /**
   * @param {object} deps
   * @param {() => string} deps.apiBaseUrl  当前服务器 API base（http(s)://…/api）
   * @param {() => {token: string|null, refreshToken: string|null}} deps.readAuth
   * @param {() => string} deps.getDeviceId  共享设备身份（desktopPrefs.ensureDesktopDeviceId）
   * @param {() => Promise<object>} deps.buildEnv  main.cjs 的 buildShellEnv()
   * @param {typeof WebSocket} [deps.WebSocketImpl]  测试注入
   * @param {object} [deps.ptyImpl]  node-pty（缺省 require('node-pty')，测试注入假实现）
   * @param {(level: string, msg: string) => void} [deps.log]
   * @param {number} [deps.heartbeatIntervalMs]
   */
  constructor(deps) {
    this.deps = deps
    this.log = deps.log ?? ((level, msg) => { console.log(`[terminal-host] ${level} ${msg}`) })
    /** @type {Map<string, {pty: object, shell: string, cwd: string}>} */
    this.terminals = new Map()
    this.socket = null
    this.connected = false
    this.role = null
    this.stopped = false
    this.reconnectDelay = RECONNECT_INITIAL_MS
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.lastServerMessageAt = 0
    /** 每终端一份丢帧标记：下一次可发送时先补一行提示。 */
    this.dropped = new Set()
  }

  get pty() {
    if (this._pty == null) {
      // 顶层 require 会让 ubuntu --ignore-scripts 的测试环境直接失败；
      // 主进程里 node-pty 是常规依赖，但懒加载可以和 fake 注入共存
      this._pty = this.deps.ptyImpl ?? require('node-pty')
    }
    return this._pty
  }

  start() {
    this.stopped = false
    this.scheduleReconnect(0)
  }

  /** 应用退出：杀掉全部中继 PTY 并停掉重连循环。 */
  shutdown() {
    this.stopped = true
    this.clearTimers()
    this.killAllTerminals()
    this.closeSocket(1000, 'app quit')
  }

  /**
   * auth-set-tokens 写盘后的钩子（§4.5 token 生命周期）：
   * 不主动断连（避免无谓抖动），只在账号切换（userId 变化）时按登出语义杀掉本进程
   * 全部中继 PTY；断线重连时自然会拿到新 token。
   */
  onTokensWritten(token) {
    const nextUserId = userIdFromToken(token)
    if (nextUserId != null && this.currentUserId != null && nextUserId !== this.currentUserId) {
      this.log('warn', `account switched (userId ${this.currentUserId} -> ${nextUserId}), killing relay terminals`)
      this.killAllTerminals()
    }
    if (nextUserId != null) this.currentUserId = nextUserId
    // 未连接时（登出后重新登录等）：踢一次重连，不必等退避计时器走完
    if (!this.connected && !this.stopped) this.scheduleReconnect(0)
  }

  /** 登出（auth-clear-tokens）：关闭 socket 并杀掉中继 PTY（§4.6）。 */
  onLoggedOut() {
    this.currentUserId = null
    this.killAllTerminals()
    if (this.connected) {
      this.closeSocket(1000, 'logged out')
    }
    this.scheduleReconnect(RECONNECT_INITIAL_MS)
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect(delayMs) {
    if (this.stopped || this.reconnectTimer) return
    const delay = delayMs ?? this.reconnectDelay
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch((e) => {
        this.log('warn', `connect failed: ${e?.message ?? e}`)
      })
    }, delay)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  async connect() {
    if (this.stopped || (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1))) return
    const auth = this.deps.readAuth() ?? { token: null, refreshToken: null }
    if (!auth.token) {
      // 未登录：等下一次 auth-set-tokens 钩子踢重连
      return
    }
    let deviceId
    try {
      deviceId = this.deps.getDeviceId()
    } catch (e) {
      this.log('warn', `device id unavailable: ${e?.message ?? e}`)
      return
    }
    if (!deviceId) return
    const url = toWsUrl(this.deps.apiBaseUrl())
    let socket
    try {
      socket = new (this.deps.WebSocketImpl ?? WebSocket)(url, { maxPayload: MAX_INBOUND_BYTES })
    } catch (e) {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('open', () => {
      if (this.socket !== socket) return
      this.connected = true
      this.role = null
      this.reconnectDelay = RECONNECT_INITIAL_MS
      this.lastServerMessageAt = Date.now()
      // auth 首帧：token 不进握手 URL；terminals 带上仍活着的 id 供服务器对账（§4.9）
      socket.send(JSON.stringify({
        type: 'auth',
        token: auth.token,
        deviceId,
        client: 'electron',
        terminals: [...this.terminals.keys()],
      }))
      this.startHeartbeat(socket)
    })
    socket.on('message', (raw) => {
      if (this.socket !== socket) return
      this.lastServerMessageAt = Date.now()
      const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
      if (size > MAX_INBOUND_BYTES) {
        // 异常帧：按主机断开处理，服务器会在宽限/替换路径里收敛登记
        socket.close(1009, 'frame too large')
        return
      }
      this.handleMessage(socket, raw)
    })
    socket.on('close', (code) => {
      if (this.socket !== socket) return
      this.connected = false
      this.role = null
      this.stopHeartbeat()
      this.socket = null
      if (this.stopped) return
      // 指数退避 ≤30s；token 失效（1003）也走同一循环，等下一次 auth-set-tokens / 刷新
      this.scheduleReconnect()
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
      if (code === 1003) {
        this.log('warn', 'auth rejected (token expired?); waiting for next token refresh')
      }
    })
    socket.on('error', () => { /* close 随后触发 */ })
  }

  startHeartbeat(socket) {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== 1) return
      if (Date.now() - this.lastServerMessageAt > 90_000) {
        socket.close()
        return
      }
      this.sendSafe(socket, { type: 'ping' })
    }, this.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  closeSocket(code, reason) {
    const socket = this.socket
    this.socket = null
    this.connected = false
    this.role = null
    this.stopHeartbeat()
    if (socket) {
      try {
        socket.close(code, reason)
      } catch { /* 已关闭 */ }
    }
  }

  handleMessage(socket, raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch {
      return
    }
    switch (frame?.type) {
      case 'connected':
        this.role = frame.role === 'standby' ? 'standby' : 'active'
        this.currentUserId = Number(frame.userId) || this.currentUserId
        this.log('info', `connected as ${this.role}`)
        return
      case 'open':
        void this.handleOpen(frame)
        return
      case 'input':
      case 'resize':
      case 'kill':
        this.handleTerminalControl(frame)
        return
      case 'pong':
        return
      default:
        return
    }
  }

  /** 服务器送来的 open（§4.6）：cwd 必须是已存在的目录，spawn 用 buildShellEnv + TERM 覆盖。 */
  async handleOpen(frame) {
    const terminalId = typeof frame.terminalId === 'string' ? frame.terminalId : ''
    if (!terminalId || !this.connected || this.socket == null) return
    if (this.role === 'standby') return // 待命端不 spawn（§4.5）
    if (this.terminals.has(terminalId)) return
    const cwd = typeof frame.cwd === 'string' && frame.cwd !== '' ? frame.cwd : ''
    const cols = clampInt(frame.cols, 80, 1, 500)
    const rows = clampInt(frame.rows, 24, 1, 200)
    if (!cwd) {
      this.send({ type: 'open_failed', terminalId, code: 'CWD_MISSING' })
      return
    }
    try {
      const stat = await fs.promises.stat(cwd)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch {
      this.send({ type: 'open_failed', terminalId, code: 'CWD_MISSING' })
      return
    }
    try {
      const baseEnv = this.deps.buildEnv ? await this.deps.buildEnv() : { ...process.env }
      // buildShellEnv 把 TERM 固定为 'dumb'（main.cjs）：spread 之后必须覆盖回 xterm-256color，
      // 否则 vim / 颜色全部退化（§4.6 评审补充）
      const env = { ...baseEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      const shell = detectShell(process.platform)
      const ptyProcess = this.pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
      this.terminals.set(terminalId, { pty: ptyProcess, shell, cwd })
      ptyProcess.onData((data) => this.sendOutput(terminalId, data))
      ptyProcess.onExit(({ exitCode }) => {
        // 已被 kill/exit 移除时是空操作；这里统一移除并上送退出帧
        if (this.terminals.delete(terminalId)) {
          this.send({ type: 'exit', terminalId, exitCode: Number(exitCode) || 0 })
        }
      })
      this.send({ type: 'opened', terminalId, shell, cwd })
    } catch (e) {
      this.log('warn', `spawn failed for ${terminalId}: ${e?.message ?? e}`)
      this.send({ type: 'open_failed', terminalId, code: 'SPAWN_FAILED' })
    }
  }

  /** input / resize / kill 只作用于中继 map；未知 id 忽略（§4.6）。 */
  handleTerminalControl(frame) {
    const terminalId = typeof frame.terminalId === 'string' ? frame.terminalId : ''
    const session = this.terminals.get(terminalId)
    if (!session) return
    if (frame.type === 'input') {
      if (typeof frame.data === 'string' && frame.data !== '') session.pty.write(frame.data)
      return
    }
    if (frame.type === 'resize') {
      const cols = clampInt(frame.cols, 80, 1, 500)
      const rows = clampInt(frame.rows, 24, 1, 200)
      try {
        session.pty.resize(cols, rows)
      } catch { /* 已退出 */ }
      return
    }
    // kill：PTY 的 onExit 会补 exit 帧（该分支下 map 已被清）
    try {
      session.pty.kill()
    } catch { /* 已退出 */ }
    this.terminals.delete(terminalId)
    this.dropped.delete(terminalId)
    this.send({ type: 'exit', terminalId, exitCode: 0 })
  }

  /** PTY 输出上送：256KB UTF-8 边界切片 + bufferedAmount 背压丢帧（§4.6/§4.10）。 */
  sendOutput(terminalId, data) {
    if (!this.connected || this.socket == null || this.socket.readyState !== 1) return
    if (this.socket.bufferedAmount > SOCKET_BACKPRESSURE_BYTES) {
      // 丢掉本片并记一笔；不暂停读取，避免 PTY 把主进程堵住
      this.dropped.add(terminalId)
      return
    }
    if (this.dropped.delete(terminalId)) {
      // 补提示与后续输出同为 output 帧：服务器环形缓冲对两者一视同仁
      this.sendRaw(JSON.stringify({ type: 'output', terminalId, data: DROPPED_NOTICE }))
    }
    for (const chunk of sliceUtf8(data, HOST_DATA_CHUNK_BYTES)) {
      this.sendRaw(JSON.stringify({ type: 'output', terminalId, data: chunk }))
    }
  }

  sendRaw(payload) {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    try {
      socket.send(payload)
    } catch (e) {
      this.log('warn', `send failed: ${e?.message ?? e}`)
    }
  }

  send(frame) {
    this.sendSafe(this.socket, frame)
  }

  sendSafe(socket, frame) {
    if (!socket || socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify(frame))
    } catch (e) {
      this.log('warn', `send failed: ${e?.message ?? e}`)
    }
  }

  killAllTerminals() {
    for (const [terminalId, session] of [...this.terminals.entries()]) {
      try {
        session.pty.kill()
      } catch { /* 已退出 */ }
      this.terminals.delete(terminalId)
      this.dropped.delete(terminalId)
    }
  }

  /** 测试 / 诊断用。 */
  terminalIds() {
    return [...this.terminals.keys()]
  }
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

module.exports = {
  TerminalHost,
  sliceUtf8,
  userIdFromToken,
  detectShell,
  toWsUrl,
  HOST_FRAME_MAX_BYTES,
  HOST_DATA_CHUNK_BYTES,
  SOCKET_BACKPRESSURE_BYTES,
  DROPPED_NOTICE,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
}
