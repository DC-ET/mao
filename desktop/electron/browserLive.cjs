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
const { spawnSync } = require('child_process')

const RECONNECT_MAX_TRIES = 30
const RECONNECT_INTERVAL_MS = 2000
const LIVE_FILE_POLL_INTERVAL_MS = 1500
const LIVE_FILE_POLL_MAX_TRIES = 12
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
        source: s.source, frame: s.isLive ? lastFrames.get(String(sessionId)) ?? null : null,
      }
    }
    return result
  }

  function sendToMainWindow(channel, data) {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null
    if (main) main.webContents.send(channel, data)
  }

  /** sessionId -> 最新帧 JPEG base64：画中画窗等迟到消费者在 getState 快照里取画面 */
  const lastFrames = new Map()

  function broadcast(sessionId, evt) {
    if (evt.type === 'browser_frame' && typeof evt.data?.jpeg === 'string') {
      lastFrames.set(String(sessionId), evt.data.jpeg)
    }
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
      console.log(`[browser-live] session ${sessionId}: live started (${evt.data?.pageUrl ?? ''})`)
      // 订阅/重连补发（replay）：同一场直播的状态校准。主进程已有直播态时不重复弹窗，
      // 尊重用户手动收起的画中画；应用重启后 hub 无态（wasLive=false）仍照常弹出。
      const replayLive = evt.data?.replay === true && state.isLive
      state.isLive = true
      state.stoppedReason = null
      state.width = evt.data?.width ?? 0
      state.height = evt.data?.height ?? 0
      state.pageUrl = evt.data?.pageUrl ?? ''
      state.cliSession = evt.data?.cliSession ?? 'default'
      setActive(sessionId)
      if (!replayLive) pip?.show()
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
      // 断开残留 SSE/重连定时器并清 live（旧端口/token 已死）：不清的话下一场
      // attachLocalSession 会早退去连死端口，scheduleReconnect 又被 stoppedReason
      // 拦截，同会话第二场直播永远连不上（「已结束」卡死）
      stopSse(state)
      state.live = null
      lastFrames.delete(String(sessionId))
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
    if (state.source === 'local' && state.live) { startSse(sessionId); return }
    if (state.source === 'local' && state.liveFileTimer) {
      // 轮询在途时被再次挂载（审批通过路径）：重置计数延长窗口而非空操作早退。
      // 真机时序：eager attach 的窗口可能烧在审批等待里，批准后 wrapper 再过数秒才落盘
      // live.json，在途早退会两头落空（2026-11-21 Windows 真机 smoke）
      state.pollTries = 0
      return
    }
    state.source = 'local'
    // 新一轮浏览器尝试（shell 工具触发）：上一场的停止状态不再拦截本轮
    // poll（L243 守卫）与 scheduleReconnect（L196 守卫），第二场直播才能连上
    state.stoppedReason = null
    if (state.live) { startSse(sessionId); return }
    state.pollTries = 0
    const poll = () => {
      state.liveFileTimer = null
      const fresh = readLiveFile(sessionId)
      if (fresh) {
        console.log(`[browser-live] session ${sessionId}: live.json found (port ${fresh.httpPort}), connecting SSE`)
        state.live = fresh
        startSse(sessionId)
        return
      }
      state.pollTries += 1
      if (state.pollTries <= LIVE_FILE_POLL_MAX_TRIES && !state.stoppedReason) {
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

  // ---------- 回放读取（V202，技术方案 2026-11-22 §4.2）：主进程 fs 直读本机 runtime 目录 ----------

  const LIVE_ID_PATTERN = /^L\d+$/

  /** liveId 白名单 + containment 断言：resolve 后必须仍在该会话的 replay 目录内（renderer 传入必须防穿越）。 */
  function resolveLiveDir(root, liveId) {
    if (!LIVE_ID_PATTERN.test(liveId)) return null
    const resolved = path.resolve(root, liveId)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
    return resolved
  }

  function readManifestSafe(liveDir, liveId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(liveDir, 'manifest.json'), 'utf8'))
      if (parsed?.liveId !== liveId || typeof parsed?.startedAt !== 'number') return null
      return parsed
    } catch { return null }
  }

  function readTimelineSafe(liveDir) {
    let raw = ''
    try { raw = fs.readFileSync(path.join(liveDir, 'timeline.ndjson'), 'utf8') } catch { return [] }
    const frames = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed)
        if (typeof row?.seq !== 'number' || typeof row?.ts !== 'number' || typeof row?.file !== 'string') continue
        frames.push(row)
      } catch { /* 崩溃留下的尾部半行：跳过 */ }
    }
    return frames
  }

  /** 场次列表（含 endedAt=null 的未结算场），按 startedAt 倒序；与 CLOUD API 同结构。 */
  function replayList(sessionId) {
    const sid = Number(sessionId)
    if (!Number.isSafeInteger(sid) || sid <= 0) return []
    const replayRoot = path.join(resolveSessionRuntimeDir(sid), '.mao-browser', 'replay')
    let names = []
    try {
      names = fs.readdirSync(replayRoot)
    } catch { return [] } // 目录不存在 = 从未录制
    const summaries = []
    for (const name of names) {
      if (!LIVE_ID_PATTERN.test(name)) continue
      const manifest = readManifestSafe(path.join(replayRoot, name), name)
      if (!manifest) continue
      summaries.push({
        liveId: manifest.liveId,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt ?? null,
        frameCount: manifest.frameCount ?? 0,
        durationMs: manifest.durationMs ?? null,
        approxBytes: manifest.approxBytes ?? 0,
        truncated: manifest.truncated === true,
      })
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt)
    return summaries
  }

  function replayTimeline(sessionId, liveId) {
    const sid = Number(sessionId)
    if (!Number.isSafeInteger(sid) || sid <= 0) return null
    const liveDir = resolveLiveDir(path.join(resolveSessionRuntimeDir(sid), '.mao-browser', 'replay'), String(liveId ?? ''))
    if (!liveDir) return null
    const manifest = readManifestSafe(liveDir, String(liveId))
    if (!manifest) return null
    return { manifest, frames: readTimelineSafe(liveDir) }
  }

  /** 单帧 JPEG 字节（Buffer，structured clone 直达 renderer）；非法/缺失返回 null。 */
  function replayFrame(sessionId, liveId, seq) {
    const sid = Number(sessionId)
    if (!Number.isSafeInteger(sid) || sid <= 0) return null
    const liveDir = resolveLiveDir(path.join(resolveSessionRuntimeDir(sid), '.mao-browser', 'replay'), String(liveId ?? ''))
    if (!liveDir) return null
    if (!Number.isSafeInteger(seq) || seq < 0) return null
    const file = path.resolve(liveDir, `f${seq}.jpg`)
    if (!file.startsWith(liveDir + path.sep)) return null
    try {
      if (!fs.statSync(file).isFile()) return null
      return fs.readFileSync(file)
    } catch { return null }
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

  /** 收起画中画（仅停止观看）：只隐藏窗口，不停浏览器、不断帧流，Agent 继续执行。 */
  function hidePip() {
    pip?.hide()
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
    // 收起画中画：与关窗同语义（仅停止观看），不触 stopBrowser
    ipcMain.on('browser-live-hide', () => hidePip())
    // 回放读取（V202）：renderer 传入的 liveId/seq 经白名单 + containment 断言后 fs 直读
    ipcMain.handle('browser-live-replay-list', (_e, payload) => replayList(payload?.sessionId))
    ipcMain.handle('browser-live-replay-timeline', (_e, payload) => replayTimeline(payload?.sessionId, payload?.liveId))
    ipcMain.handle('browser-live-replay-frame', (_e, payload) => replayFrame(payload?.sessionId, payload?.liveId, payload?.seq))
  }

  function shutdown() {
    const liveLocal = [...sessions.entries()]
      .filter(([, s]) => s.source === 'local' && s.live && s.isLive)
      .map(([id]) => id)
    console.log(`[browser-live] shutdown: ${sessions.size} session(s), live local: [${liveLocal.join(',')}]`)
    for (const [sessionId, state] of sessions) {
      stopSse(state)
      if (state.liveFileTimer) { clearTimeout(state.liveFileTimer); state.liveFileTimer = null }
      // 退出前对仍在直播的 LOCAL 会话补发 /stop：sidecar 与浏览器是 detached 孤儿，不补发
      // 则应用退出后存活到 2h 硬上限（方案 D4 兜底链缺口；2026-11-21 Windows 真机 smoke：
      // 优雅退出后 sidecar/chrome 均存活实证）。同步 spawn curl：退出流里异步 http 可能
      // 来不及 flush，同步执行保证请求在进程退出前确实发出。
      if (state.source === 'local' && state.live && state.isLive) {
        try {
          spawnSync('curl', [
            '-s', '-m', '2', '-X', 'POST',
            `http://127.0.0.1:${state.live.httpPort}/stop?token=${encodeURIComponent(state.live.token)}`,
            '-H', 'Content-Type: application/json',
            '-d', JSON.stringify({ sessionId }),
          ], { windowsHide: true, timeout: 3000 })
        } catch { /* 尽力而为：sidecar 有 2h 硬上限兜底 */ }
      }
    }
    sessions.clear()
  }

  return {
    attachLocalSession, relayRendererEvent, stopBrowser, sessionEnded, hidePip, registerIpc, shutdown, snapshot,
    replayList, replayTimeline, replayFrame,
  }
}

module.exports = { createBrowserLiveRuntime }
