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
/** 跨会话本机回放扫描的单次返回上限（技术方案 2026-11-27 §6.3，与服务端 manifest 读取上限同量级） */
const REPLAY_LIST_ALL_CAP = 2000
/** 单次扫描枚举的会话目录上限：主进程同步 IO 不随会话总数无界增长（超限报 truncated） */
const REPLAY_SCAN_SESSION_CAP = 2000
const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

function createBrowserLiveRuntime({
  resolveSessionRuntimeDir,
  resolveLocalRuntimeRoot,
  getMainWindow,
  pip,
}) {
  /**
   * sessionId -> {
   *   source: 'local' | 'cloud',
   *   live: { httpPort, token } | null,   // LOCAL sidecar 出口
   *   sseReq, reconnectTimer, liveFileTimer, reconnectTries,
   *   live: boolean, pageUrl, width, height, cliSession, stoppedReason, lastSeq,
   *   startedControl: boolean,            // sidecar 能力协商（D6）：协作输入入口开关
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
        cliSession: 'default', stoppedReason: null, lastSeq: 0, startedControl: false, buf: '',
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
        source: s.source, startedControl: s.startedControl,
        frame: s.isLive ? lastFrames.get(String(sessionId)) ?? null : null,
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
      // P-1（技术方案 2026-11-27 §1.3）：画中画不再自动弹出——自动弹出打扰工作且
      // 误触「停止浏览器」杀掉 Agent 浏览器；观看入口收敛为 Tab 内「打开画中画」
      // 手动按钮（isLive 门控）。replay 守卫随自动弹出一并删除（无意义）。
      state.isLive = true
      state.stoppedReason = null
      state.width = evt.data?.width ?? 0
      state.height = evt.data?.height ?? 0
      state.pageUrl = evt.data?.pageUrl ?? ''
      state.cliSession = evt.data?.cliSession ?? 'default'
      // 能力协商（D6）：非 replay started 以 data 定值；replay（CLOUD 订阅重放）只在
      // 显式携带 boolean 时校准——刷新靠 getState 快照恢复直播态，control 必须随快照
      // 下发，否则刷新后「协作操作」入口消失到下一场（评审 P2-1）
      if (evt.data?.replay === true) {
        if (typeof evt.data?.control === 'boolean') state.startedControl = evt.data.control
      } else {
        state.startedControl = evt.data?.control === true
      }
      setActive(sessionId)
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
      state.startedControl = false
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

  /**
   * 协作输入（技术方案 2026-11-27 §8）：POST sidecar /input。
   * 旧 sidecar 无 /input 路由 → 404 → 'unsupported'，renderer 据此关闭交互入口并提示
   * 「采集端版本过旧」；403 是 token 失配（sidecar 重启换 token，SSE 重连会拿到新
   * live.json），按丢批处理返回 'ok'（评审 P2-6：403 误报「版本过旧」会误导排障）；
   * 其余情况一律 'ok'（输入丢了就丢了，交互语义）。
   */
  function postInput(state, payload) {
    if (!state.live) return Promise.resolve('ok')
    return new Promise((resolve) => {
      const body = JSON.stringify(payload ?? {})
      const req = http.request({
        host: '127.0.0.1', port: state.live.httpPort,
        path: `/input?token=${encodeURIComponent(state.live.token)}`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 3000,
      }, (res) => {
        res.resume()
        res.on('end', () => {
          resolve(res.statusCode === 404 ? 'unsupported' : 'ok')
        })
      })
      req.on('error', () => resolve('ok'))
      req.on('timeout', () => { req.destroy(); resolve('ok') })
      req.end(body)
    })
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

  /** 时间窗命中判定：from/to 为 epoch ms，闭区间；null = 该侧无界。 */
  function inReplayWindow(startedAt, fromMs, toMs) {
    if (fromMs != null && startedAt < fromMs) return false
    if (toMs != null && startedAt > toMs) return false
    return true
  }

  /**
   * 跨会话本机回放扫描（技术方案 2026-11-27 §6.3）：扫 localRuntimeRoot 下各会话目录的
   * .mao-browser/replay，只取 L\d+ 场次；只覆盖当前服务器 hostKey 的会话目录（避免跨服务器 sessionId 撞号）。
   * 入参只接受数字时间窗（epoch ms）：非有限数字按无界处理；from > to 直接空列表。
   * 会话目录名必须为数字；manifest.sessionId 落盘是字符串（host 侧 String(args.session)），
   * 与目录名按字符串比对，不一致即跳过。
   * 单次返回上限 REPLAY_LIST_ALL_CAP 场：目录名 / liveId 均按时间戳倒序扫，达到上限即停，
   * 因此截断时保留的是较新的场次。坏 manifest / 空目录 / 目录不存在一律跳过。
   * 另设会话目录枚举上限 REPLAY_SCAN_SESSION_CAP：主进程同步 IO 不随会话总数无界增长。
   * 返回 { rows, truncated }：任一上限触顶都置 truncated（与后端 truncatedCandidates 同口径），
   * 由渲染层提示「结果可能不完整」；旧主进程没有本函数，渲染层按特性探测降级。
   */
  function replayListAll(from, to) {
    if (typeof resolveLocalRuntimeRoot !== 'function') return { rows: [], truncated: false }
    const fromMs = Number.isFinite(from) ? from : null
    const toMs = Number.isFinite(to) ? to : null
    if (fromMs != null && toMs != null && fromMs > toMs) return { rows: [], truncated: false }
    const runtimeRoot = resolveLocalRuntimeRoot()
    let sessionNames = []
    try {
      sessionNames = fs.readdirSync(runtimeRoot)
    } catch { return { rows: [], truncated: false } } // 本机从未录制
    sessionNames = sessionNames
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a))
    let scannedSessions = 0
    let truncated = false
    const rows = []
    for (const name of sessionNames) {
      if (scannedSessions >= REPLAY_SCAN_SESSION_CAP) {
        truncated = true
        break
      }
      scannedSessions += 1
      const replayRoot = path.join(runtimeRoot, name, '.mao-browser', 'replay')
      let liveNames = []
      try {
        liveNames = fs.readdirSync(replayRoot)
      } catch { continue } // 该会话从未录制
      liveNames = liveNames
        .filter((liveId) => LIVE_ID_PATTERN.test(liveId))
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
      for (const liveId of liveNames) {
        if (!inReplayWindow(Number(liveId.slice(1)), fromMs, toMs)) continue
        const manifest = readManifestSafe(path.join(replayRoot, liveId), liveId)
        if (!manifest) continue
        if (String(manifest.sessionId) !== name) continue
        rows.push({
          sessionId: Number(name),
          liveId: manifest.liveId,
          startedAt: manifest.startedAt,
          endedAt: manifest.endedAt ?? null,
          durationMs: manifest.durationMs ?? null,
          frameCount: manifest.frameCount ?? 0,
          approxBytes: manifest.approxBytes ?? 0,
          truncated: manifest.truncated === true,
          pageUrl: Array.isArray(manifest.urls) ? manifest.urls[0] ?? '' : '',
        })
        if (rows.length >= REPLAY_LIST_ALL_CAP) {
          truncated = true
          break
        }
      }
      if (rows.length >= REPLAY_LIST_ALL_CAP) break
    }
    rows.sort((a, b) => b.startedAt - a.startedAt)
    return { rows, truncated }
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

  /**
   * 协作输入（技术方案 2026-11-27 §7.3）：LOCAL 直 POST sidecar /input；CLOUD 转请主窗
   * renderer 发 WS 帧（WS 连接在 renderer 侧，与 stop 同范式）。返回 Promise<'ok' |
   * 'unsupported'>——renderer 不区分模式，'unsupported' 只可能来自 LOCAL 旧 sidecar。
   */
  function inputBrowser(sessionId, payload) {
    const state = sessions.get(Number(sessionId))
    if (state && state.source === 'local') {
      return postInput(state, payload)
    }
    sendToMainWindow('browser-live-input-relay', { sessionId: Number(sessionId), payload })
    return Promise.resolve('ok')
  }

  /** 收起画中画（仅停止观看）：只隐藏窗口，不停浏览器、不断帧流，Agent 继续执行。 */
  function hidePip() {
    pip?.hide()
  }

  /**
   * 协作键盘捕获开关（技术方案 2026-11-27 §7.1）：overlay 聚焦时屏蔽主窗应用菜单加速键
   * （Cmd+W/Q/R 等会被菜单先吃掉，到不了 overlay 也到不了远端）。用 webContents
   * setIgnoreMenuShortcuts（Electron 官方口径：只屏蔽菜单快捷键，页面 keydown 照常派发）。
   * 失焦 / 退出协作 / 停止直播时由 renderer 回置 false；主窗重建默认也是 false。
   */
  function setCollabKeys(active) {
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null
    try { main?.webContents?.setIgnoreMenuShortcuts?.(Boolean(active)) } catch { /* 旧版本无此 API */ }
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
    // 协作输入（技术方案 2026-11-27 §8）：高频小包，invoke 逐批回执 'ok' / 'unsupported'
    ipcMain.handle('browser-live-input', (_e, payload) => {
      if (payload?.sessionId != null) return inputBrowser(Number(payload.sessionId), payload.payload)
      return Promise.resolve('ok')
    })
    // 协作键盘捕获（§7.1）：overlay 聚焦 → 屏蔽菜单加速键；失焦 → 恢复
    ipcMain.on('browser-live-collab-keys', (_e, payload) => setCollabKeys(Boolean(payload?.active)))
    ipcMain.on('browser-live-restore', () => { pip?.show() })
    // 收起画中画：与关窗同语义（仅停止观看），不触 stopBrowser
    ipcMain.on('browser-live-hide', () => hidePip())
    // 回放读取（V202）：renderer 传入的 liveId/seq 经白名单 + containment 断言后 fs 直读
    ipcMain.handle('browser-live-replay-list', (_e, payload) => replayList(payload?.sessionId))
    // 跨会话本机扫描（技术方案 2026-11-27 §6.3）：renderer 只传数字时间窗，根目录固定本机 runtime
    ipcMain.handle('browser-live-replay-list-all', (_e, payload) => replayListAll(payload?.from, payload?.to))
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
    attachLocalSession, relayRendererEvent, stopBrowser, inputBrowser, sessionEnded, hidePip, registerIpc, shutdown, snapshot,
    replayList, replayListAll, replayTimeline, replayFrame,
  }
}

module.exports = { createBrowserLiveRuntime }
