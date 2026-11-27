'use strict'

/**
 * 浏览器直播枢纽测试（方案 2026-11-20 v2 §6）：真实本地 SSE server 模拟 sidecar 出口，
 * 验证 live.json 发现 → SSE 连接 → 事件扇出（主窗 + 画中画）→ 停止下行（POST /stop）
 * → 会话终态收窗。模块零 Electron 依赖，主进程测试沿用 node --test 直载模式。
 */

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createBrowserLiveRuntime } = require('./browserLive.cjs')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 假 sidecar：SSE 出口 + POST /stop 接收端，事件写入由测试驱动。 */
async function startFakeSidecar() {
  const subscribers = new Set()
  const stopRequests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/stop') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        stopRequests.push(url.searchParams.get('token'))
        res.writeHead(200).end()
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/live') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(':live\n\n')
      subscribers.add(res)
      req.on('close', () => subscribers.delete(res))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    stopRequests,
    emit(type, data) {
      for (const res of subscribers) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

function setupRuntime(runtimeDir) {
  const mainWindowSends = []
  const pipCalls = { show: 0, hide: 0, sends: [] }
  const runtime = createBrowserLiveRuntime({
    resolveSessionRuntimeDir: (sessionId) => path.join(runtimeDir, String(sessionId)),
    getMainWindow: () => ({ webContents: { send: (channel, data) => mainWindowSends.push({ channel, data }) } }),
    pip: {
      show: () => { pipCalls.show += 1 },
      hide: () => { pipCalls.hide += 1 },
      send: (channel, data) => pipCalls.sends.push({ channel, data }),
    },
  })
  const ipc = { handlers: {}, onHandlers: {} }
  runtime.registerIpc({
    handle: (name, fn) => { ipc.handlers[name] = fn },
    on: (name, fn) => { ipc.onHandlers[name] = fn },
  })
  return { runtime, ipc, mainWindowSends, pipCalls }
}

test('browserLive hub: 发现 live.json → SSE 扇出 → 停止下行 → 终态收窗', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-'))
  const sidecar = await startFakeSidecar()
  try {
    fs.mkdirSync(path.join(runtimeDir, '11', '.mao-browser'), { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, '11', '.mao-browser', 'live.json'),
      JSON.stringify({ httpPort: sidecar.port, token: 'tok-11', pid: 4242 }),
    )
    const { runtime, ipc, mainWindowSends, pipCalls } = setupRuntime(runtimeDir)

    runtime.attachLocalSession(11)
    // attachLocalSession 首轮 poll 是同步读 + 异步连接，稍候 SSE 建立并推事件
    await sleep(300)
    sidecar.emit('browser_live_started', { width: 1280, height: 720, pageUrl: 'https://example.com', cliSession: 'default' })
    sidecar.emit('browser_frame', { seq: 1, ts: 1, jpeg: 'Zg==', width: 1280, height: 720, pageUrl: 'https://example.com' })
    await sleep(100)

    // started → 画中画弹出；事件扇出主窗 + 画中画
    assert.ok(pipCalls.show >= 1, 'pip should show on browser_live_started')
    const startedMain = mainWindowSends.find((s) => s.channel === 'browser-live-event' && s.data.type === 'browser_live_started')
    assert.ok(startedMain, 'main window should receive browser_live_started')
    assert.strictEqual(startedMain.data.sessionId, 11)
    const framePip = pipCalls.sends.find((s) => s.channel === 'browser-live-event' && s.data.type === 'browser_frame')
    assert.ok(framePip, 'pip window should receive browser_frame')

    // 快照可查
    const snapshot = ipc.handlers['browser-live-get-state']()
    assert.strictEqual(snapshot.sessions['11'].isLive, true)
    assert.strictEqual(snapshot.activeSessionId, 11)

    // 停止浏览器（LOCAL）→ POST /stop 到 sidecar
    ipc.onHandlers['browser-live-stop'](null, { sessionId: 11 })
    await sleep(200)
    assert.strictEqual(sidecar.stopRequests.length, 1, 'sidecar should receive POST /stop')

    // sidecar 广播 stopped → 全部停后画中画收起（2s 延迟由真实定时器驱动）
    sidecar.emit('browser_live_stopped', { reason: 'user_stop' })
    assert.strictEqual(pipCalls.hide, 0, 'pip hide is deferred 2s after stop')
    await sleep(2400)
    assert.ok(pipCalls.hide >= 1, 'pip should hide after all sessions stopped')

    runtime.shutdown()
  } finally {
    await sidecar.close()
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('browserLive hub: CLOUD 事件回灌与停止转请 renderer', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-cloud-'))
  const sidecar = await startFakeSidecar()
  try {
    const { runtime, ipc, mainWindowSends } = setupRuntime(runtimeDir)

    // CLOUD：renderer（useStreamWS）回灌事件 → 直接扇出
    ipc.onHandlers['browser-live-relay'](null, { sessionId: 22, type: 'browser_live_started', data: { width: 800, height: 600 } })
    assert.strictEqual(mainWindowSends.filter((s) => s.channel === 'browser-live-event').length, 1)

    // CLOUD 停止：无 LOCAL sidecar 出口 → 转请 renderer 发 WS 帧
    ipc.onHandlers['browser-live-stop'](null, { sessionId: 22 })
    const relay = mainWindowSends.find((s) => s.channel === 'browser-live-stop-relay')
    assert.ok(relay, 'cloud stop should be relayed to renderer WS')
    assert.strictEqual(relay.data.sessionId, 22)
    assert.strictEqual(sidecar.stopRequests.length, 0, 'cloud stop must not hit any local sidecar')

    // 会话终态：无 LOCAL 出口的 CLOUD 会话不产生本地副作用
    ipc.onHandlers['browser-live-session-ended'](null, { sessionId: 22, phase: 'COMPLETED' })
    assert.strictEqual(sidecar.stopRequests.length, 0)

    runtime.shutdown()
  } finally {
    await sidecar.close()
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('browserLive hub: 收起画中画只 hide 窗口，不停浏览器', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-hide-'))
  try {
    const { runtime, ipc, mainWindowSends, pipCalls } = setupRuntime(runtimeDir)

    // CLOUD 直播中：收起按钮（browser-live-hide）必须与关窗同语义——只 hide，
    // 不转请 renderer 发 browser_live_stop（否则 Agent 的浏览器会被误杀）
    ipc.onHandlers['browser-live-relay'](null, { sessionId: 55, type: 'browser_live_started', data: { width: 800, height: 600 } })
    assert.strictEqual(pipCalls.show, 1)

    ipc.onHandlers['browser-live-hide'](null)

    assert.strictEqual(pipCalls.hide, 1, 'hide should hide the pip window')
    assert.strictEqual(
      mainWindowSends.filter((s) => s.channel === 'browser-live-stop-relay').length,
      0,
      'hiding must not relay a stop to the renderer',
    )

    runtime.shutdown()
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('browserLive hub: 订阅重放的 started 不重复弹出画中画', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-replay-'))
  try {
    const { runtime, ipc, pipCalls } = setupRuntime(runtimeDir)

    ipc.onHandlers['browser-live-relay'](null, { sessionId: 66, type: 'browser_live_started', data: { width: 800, height: 600 } })
    assert.strictEqual(pipCalls.show, 1)

    // 刷新主窗后后端按 subscribe 重放 started：hub 已有直播态，不再 show，
    // 否则用户刚手动收起的画中画会被刷新重新弹出来
    ipc.onHandlers['browser-live-relay'](null, { sessionId: 66, type: 'browser_live_started', data: { width: 800, height: 600, replay: true } })
    assert.strictEqual(pipCalls.show, 1, 'replayed started must not re-show a live pip window')

    // 应用重启后 hub 无态：重放仍要弹出（直播还在进行，画中画是观看入口）
    ipc.onHandlers['browser-live-relay'](null, { sessionId: 77, type: 'browser_live_started', data: { width: 800, height: 600, replay: true } })
    assert.strictEqual(pipCalls.show, 2, 'replayed started should show pip when hub has no live state')

    runtime.shutdown()
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('browserLive hub: LOCAL 会话终态 → 停 sidecar', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-end-'))
  const sidecar = await startFakeSidecar()
  try {
    fs.mkdirSync(path.join(runtimeDir, '33', '.mao-browser'), { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, '33', '.mao-browser', 'live.json'),
      JSON.stringify({ httpPort: sidecar.port, token: 'tok-33', pid: 4242 }),
    )
    const { runtime, ipc } = setupRuntime(runtimeDir)
    runtime.attachLocalSession(33)
    await sleep(300)

    // 非终态相位不触发
    ipc.onHandlers['browser-live-session-ended'](null, { sessionId: 33, phase: 'RUNNING' })
    await sleep(150)
    assert.strictEqual(sidecar.stopRequests.length, 0)

    ipc.onHandlers['browser-live-session-ended'](null, { sessionId: 33, phase: 'COMPLETED' })
    await sleep(200)
    assert.strictEqual(sidecar.stopRequests.length, 1, 'terminal phase should stop the sidecar')

    runtime.shutdown()
  } finally {
    await sidecar.close()
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('browserLive hub: LOCAL 第二场直播——停止后换新 sidecar 端口可重连（2026-11-22 回归）', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-second-'))
  const sidecarA = await startFakeSidecar()
  try {
    fs.mkdirSync(path.join(runtimeDir, '44', '.mao-browser'), { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, '44', '.mao-browser', 'live.json'),
      JSON.stringify({ httpPort: sidecarA.port, token: 'tok-a', pid: 4242 }),
    )
    const { runtime, ipc, mainWindowSends } = setupRuntime(runtimeDir)

    // 第一场：attach → started → stopped（不触发 POST /stop，模拟自然 browser_exit）
    runtime.attachLocalSession(44)
    await sleep(300)
    sidecarA.emit('browser_live_started', { width: 1280, height: 720, pageUrl: 'https://a.com', cliSession: 'default' })
    await sleep(100)
    sidecarA.emit('browser_live_stopped', { reason: 'browser_exit' })
    await sleep(100)

    // 第一场收场：sidecar A 退出，sidecar B 换新端口重写 live.json（host 重启场景）
    await sidecarA.close()
    const sidecarB = await startFakeSidecar()
    try {
      fs.writeFileSync(
        path.join(runtimeDir, '44', '.mao-browser', 'live.json'),
        JSON.stringify({ httpPort: sidecarB.port, token: 'tok-b', pid: 4243 }),
      )

      // 第二场：shell 工具再次触发 attach（旧实现会早退连死端口，永远收不到第二场）
      runtime.attachLocalSession(44)
      await sleep(300)
      sidecarB.emit('browser_live_started', { width: 800, height: 600, pageUrl: 'https://b.com', cliSession: 'default' })
      sidecarB.emit('browser_frame', { seq: 1, ts: 1, jpeg: 'Qg==', width: 800, height: 600, pageUrl: 'https://b.com' })
      await sleep(100)

      const startedSends = mainWindowSends.filter((s) => s.channel === 'browser-live-event' && s.data.type === 'browser_live_started')
      assert.ok(startedSends.length >= 2, 'second live started should fan out to main window')
      const frameSends = mainWindowSends.filter((s) => s.channel === 'browser-live-event' && s.data.type === 'browser_frame')
      assert.ok(frameSends.length >= 1, 'second live frame should fan out to main window')
      const snapshot = ipc.handlers['browser-live-get-state']()
      assert.strictEqual(snapshot.sessions['44'].isLive, true)
      assert.strictEqual(snapshot.sessions['44'].stoppedReason, null)

      runtime.shutdown()
    } finally {
      await sidecarB.close()
    }
  } finally {
    await sidecarA.close()
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})
