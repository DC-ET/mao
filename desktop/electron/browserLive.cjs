'use strict'

/**
 * 浏览器直播枢纽（方案 2026-11-20 v2 D10）：browser-use 技能 sidecar 采到的帧在此汇聚、
 * 扇出给主窗口 renderer 与画中画窗口。
 *
 * 数据面两条来源：
 * - LOCAL：本会话运行时 `.mao-browser/live.json` 发现 sidecar 的 SSE 出口（http.get 直连，
 *   不绕云端），由 tool-execute(shell) 触发发现。
 * - CLOUD：帧经后端 /api/ws/stream 送达主窗 renderer（useStreamWS），再经 IPC 回灌本枢纽。
 *
 * 停止路径统一走这里：LOCAL 直接 POST sidecar /stop；CLOUD 请主窗 renderer 发
 * browser_live_stop WS 帧（WS 连接在 renderer 侧）。会话终态（LOCAL）由 renderer
 * 通知 sessionEnded，向 sidecar 发停止——任务结束自动收窗并清理浏览器。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const RECONNECT_MAX_TRIES = 30
const RECONNECT_INTERVAL_MS = 2000
const LIVE_FILE_POLL_INTERVAL_MS = 1500
const LIVE_FILE_POLL_MAX_TRIES = 8
const PIP_HIDE_AFTER_STOP_MS = 2000
const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

function createBrowserLiveRuntime({
  resolveSessionRuntimeDir,
  getMainWindow,
  pip,
}) {
  /**
   * sessionId -> {
   *   source: 'local' | 'cloud',
   *   live: { httpPort, token } | null,   // LOCAL sidecar 出口
   *   sseReq, reconnectTimer, liveFileTimer, reconnectTries,
   *   live: boolean, pageUrl, width, height, cliSession, stoppedReason, lastSeq,
   *   buf: string,                        // SSE 半块缓冲
   * }
   */
  const sessions = new Map()
  let activeSessionId = null

  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        source: 'cloud', live: null, sseReq: null, reconnectTimer: null, liveFileTimer: null,
        reconnectTries: 0, isLive: false, pageUrl: '', width: 0, height: 0,
        cliSession: 'default', stoppedReason: null, lastSeq: 0, buf: '',
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function snapshot() {
    const result = { activeSessionId, sessions: {} }
    for (const [sessionId, s] of sessions) {
      result.sessions[sessionId] = {
        isLive: s.isLive, pageUrl: s.pageUrl, width: s.width, height: s.height,
        cliSession: s.cliSession, stoppedReason: s.stoppedReason, lastSeq: s.lastSeq,
        source: s.source,
      }
    }
    return result
  }

  function sendToMainWindow(channel, data) {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null
    if (main) main.webContents.send(channel, data)
  }

  function broadcast(sessionId, evt) {
    const payload = { sessionId, ...evt }
    sendToMainWindow('browser-live-event', payload)
    pip?.send('browser-live-event', payload)
  }

  function setActive(sessionId) {
    if (activeSessionId !== sessionId) {
      activeSessionId = sessionId
      sendToMainWindow('browser-live-active-session', { sessionId })
      pip?.send('browser-live-active-session', { sessionId })
    }
  }

  function dispatchEvent(sessionId, evt) {
    const state = stateOf(sessionId)
    if (evt.type === 'browser_live_started') {
      state.isLive = true
      state.stoppedReason = null
      state.width = evt.data?.width ?? 0
      state.height = evt.data?.height ?? 0
      state.pageUrl = evt.data?.pageUrl ?? ''
      state.cliSession = evt.data?.cliSession ?? 'default'
      setActive(sessionId)
      pip?.show()
    } else if (evt.type === 'browser_frame') {
      state.lastSeq = evt.data?.seq ?? state.lastSeq
      state.pageUrl = evt.data?.pageUrl ?? state.pageUrl
      state.cliSession = evt.data?.cliSession ?? state.cliSession
      state.width = evt.data?.width ?? state.width
      state.height = evt.data?.height ?? state.height
      setActive(sessionId)
    } else if (evt.type === 'browser_live_stopped') {
      state.isLive = false
      state.stoppedReason = evt.data?.reason ?? 'unknown'
      // 全部会话都已停：画中画稍后自动收起（让「已结束」状态可见片刻）
      const anyLive = [...sessions.values()].some((s) => s.isLive)
      if (!anyLive) {
        setTimeout(() => {
          const stillLive = [...sessions.values()].some((s) => s.isLive)
          if (!stillLive) pip?.hide()
        }, PIP_HIDE_AFTER_STOP_MS).unref?.()
      }
    }
    broadcast(sessionId, evt)
  }

  // ---------- LOCAL：sidecar SSE 消费 ----------

  function readLiveFile(sessionId) {
    try {
      const raw = fs.readFileSync(path.join(resolveSessionRuntimeDir(sessionId), '.mao-browser', 'live.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (Number.isInteger(parsed.httpPort) && typeof parsed.token === 'string') {
        return { httpPort: parsed.httpPort, token: parsed.token }
      }
    } catch { /* 尚未就绪 / 会话目录不存在 */ }
    return null
  }

  function stopSse(state) {
    if (state.sseReq) {
      try { state.sseReq.destroy() } catch { /* ignore */ }
      state.sseReq = null
    }
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  }

  function startSse(sessionId) {
    const state = stateOf(sessionId)
    stopSse(state)
    if (!state.live) return
    const req = http.get({
      host: '127.0.0.1',
      port: state.live.httpPort,
      path: `/live?token=${encodeURIComponent(state.live.token)}`,
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        scheduleReconnect(sessionId)
        return
      }
      state.reconnectTries = 0
      state.buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        state.buf += chunk
        let idx
        while ((idx = state.buf.indexOf('\n\n')) >= 0) {
          const block = state.buf.slice(0, idx)
          state.buf = state.buf.slice(idx + 2)
          const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
          if (!eventLine || !dataLine) continue
          try {
            dispatchEvent(sessionId, {
              type: eventLine.slice(7).trim(),
              data: JSON.parse(dataLine.slice(6)),
            })
          } catch { /* 坏块跳过 */ }
        }
      })
      res.on('end', () => scheduleReconnect(sessionId))
      res.on('error', () => scheduleReconnect(sessionId))
    })
    req.on('error', () => scheduleReconnect(sessionId))
    state.sseReq = req
  }

  function scheduleReconnect(sessionId) {
    const state = stateOf(sessionId)
    if (state.stoppedReason || state.reconnectTimer) return
    state.reconnectTries += 1
    if (state.reconnectTries > RECONNECT_MAX_TRIES) {
      state.live = null
      return
    }
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      // sidecar 可能已重启（端口/令牌变了）：重连前重读 live.json
      const fresh = readLiveFile(sessionId)
      if (!fresh) {
        scheduleReconnect(sessionId)
        return
      }
      state.live = fresh
      startSse(sessionId)
    }, RECONNECT_INTERVAL_MS)
    state.reconnectTimer.unref?.()
  }

  /**
   * tool-execute(shell) 触发：该会话可能出现直播。轮询 live.json（sidecar 由 wrapper
   * 在命令内拉起，监听有毫秒级延迟），就绪即连 SSE。
   */
  function attachLocalSession(sessionId) {
    const state = stateOf(sessionId)
    if (state.source === 'local' && (state.live || state.liveFileTimer)) return
    state.source = 'local'
    if (state.live) { startSse(sessionId); return }
    let tries = 0
    const poll = () => {
      state.liveFileTimer = null
      const fresh = readLiveFile(sessionId)
      if (fresh) {
        state.live = fresh
        startSse(sessionId)
        return
      }
      tries += 1
      if (tries <= LIVE_FILE_POLL_MAX_TRIES && !state.stoppedReason) {
        state.liveFileTimer = setTimeout(poll, LIVE_FILE_POLL_INTERVAL_MS)
        state.liveFileTimer.unref?.()
      }
    }
    poll()
  }

  function postStop(state, sessionId) {
    if (!state.live) return false
    const body = JSON.stringify({ sessionId })
    const req = http.request({
      host: '127.0.0.1', port: state.live.httpPort,
      path: `/stop?token=${encodeURIComponent(state.live.token)}`,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, (res) => res.resume())
    req.on('error', () => { /* sidecar 已退出：无需再停 */ })
    req.end(body)
    void sessionId
    return true
  }

  // ---------- 公共控制入口 ----------

  /** renderer → 主进程：CLOUD 帧回灌 / 一切来源的事件注入 */
  function relayRendererEvent(sessionId, evt) {
    if (!evt || typeof evt.type !== 'string') return
    dispatchEvent(Number(sessionId), evt)
  }

  /** 停止浏览器：LOCAL 直停 sidecar；CLOUD 请 renderer 发 WS 帧（browser_live_stop）。 */
  function stopBrowser(sessionId) {
    const state = sessions.get(Number(sessionId))
    if (state && state.source === 'local' && state.live) {
      postStop(state, sessionId)
      return
    }
    sendToMainWindow('browser-live-stop-relay', { sessionId: Number(sessionId) })
  }

  /** 会话终态（renderer 侧 session_status 透传）：LOCAL 停 sidecar（杀浏览器、收窗）。 */
  function sessionEnded(sessionId, phase) {
    const state = sessions.get(Number(sessionId))
    if (!state) return
    if (phase && !TERMINAL_PHASES.has(phase)) return
    if (state.source === 'local' && state.live) {
      postStop(state, sessionId)
    }
  }

  /** 画中画双击放大：收起小窗并请主窗打开直播 Tab。 */
  function expandToTab() {
    pip?.hide()
    sendToMainWindow('browser-live-expand', { sessionId: activeSessionId })
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('browser-live-get-state', () => snapshot())
    ipcMain.on('browser-live-relay', (_e, payload) => {
      if (payload && typeof payload === 'object') relayRendererEvent(payload.sessionId, payload)
    })
    ipcMain.on('browser-live-stop', (_e, payload) => {
      if (payload?.sessionId != null) stopBrowser(Number(payload.sessionId))
    })
    ipcMain.on('browser-live-session-ended', (_e, payload) => {
      if (payload?.sessionId != null) sessionEnded(Number(payload.sessionId), payload.phase)
    })
    ipcMain.on('browser-live-expand', () => expandToTab())
    ipcMain.on('browser-live-restore', () => { pip?.show() })
  }

  function shutdown() {
    for (const [, state] of sessions) {
      stopSse(state)
      if (state.liveFileTimer) { clearTimeout(state.liveFileTimer); state.liveFileTimer = null }
    }
    sessions.clear()
  }

  return { attachLocalSession, relayRendererEvent, stopBrowser, sessionEnded, registerIpc, shutdown, snapshot }
}

module.exports = { createBrowserLiveRuntime }
