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

/** 假 sidecar：SSE 出口 + POST /stop / POST /input 接收端，事件写入由测试驱动。 */
async function startFakeSidecar({ inputStatus = 200 } = {}) {
  const subscribers = new Set()
  const stopRequests = []
  const inputRequests = []
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
    if (req.method === 'POST' && url.pathname === '/input') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* 坏 body 照 404/200 语义处理 */ }
        inputRequests.push(parsed)
        res.writeHead(inputStatus).end()
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
    inputRequests,
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
  const menuShortcutCalls = []
  const pipCalls = { show: 0, hide: 0, sends: [] }
  const runtime = createBrowserLiveRuntime({
    resolveSessionRuntimeDir: (sessionId) => path.join(runtimeDir, String(sessionId)),
    getMainWindow: () => ({
      webContents: {
        send: (channel, data) => mainWindowSends.push({ channel, data }),
        setIgnoreMenuShortcuts: (v) => menuShortcutCalls.push(v),
      },
    }),
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
  return { runtime, ipc, mainWindowSends, menuShortcutCalls, pipCalls }
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

    // P-1（技术方案 2026-11-27 §1.3）：started 不再自动弹画中画（手动入口在 Tab）；
    // 事件照常扇出主窗 + 画中画
    assert.strictEqual(pipCalls.show, 0, 'pip must not auto-show on browser_live_started')
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
    assert.strictEqual(pipCalls.show, 0, 'started must not auto-show pip (P-1)')

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

test('browserLive hub: started（含 replay）不弹出画中画；手动 restore 仍可打开（P-1）', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-replay-'))
  try {
    const { runtime, ipc, pipCalls } = setupRuntime(runtimeDir)

    ipc.onHandlers['browser-live-relay'](null, { sessionId: 66, type: 'browser_live_started', data: { width: 800, height: 600 } })
    // P-1：自动弹出删除——无论真 started 还是刷新后的 replay started 都不 show
    assert.strictEqual(pipCalls.show, 0)

    // 刷新主窗后后端按 subscribe 重放 started：同样不弹出
    ipc.onHandlers['browser-live-relay'](null, { sessionId: 66, type: 'browser_live_started', data: { width: 800, height: 600, replay: true } })
    assert.strictEqual(pipCalls.show, 0, 'replayed started must not show pip')

    // 观看入口收敛为手动：Tab 内「打开画中画」→ browser-live-restore
    ipc.onHandlers['browser-live-restore'](null)
    assert.strictEqual(pipCalls.show, 1, 'manual restore should show pip')

    runtime.shutdown()
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('browserLive hub: LOCAL 协作输入 POST /input；CLOUD 转请 renderer；404 → unsupported、403 → 丢批', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-bl-input-'))
  const sidecar = await startFakeSidecar()
  const oldSidecar = await startFakeSidecar({ inputStatus: 404 })
  const staleTokenSidecar = await startFakeSidecar({ inputStatus: 403 })
  try {
    for (const sid of [88, 99, 77]) {
      fs.mkdirSync(path.join(runtimeDir, String(sid), '.mao-browser'), { recursive: true })
    }
    fs.writeFileSync(
      path.join(runtimeDir, '88', '.mao-browser', 'live.json'),
      JSON.stringify({ httpPort: sidecar.port, token: 'tok-88', pid: 4242 }),
    )
    fs.writeFileSync(
      path.join(runtimeDir, '99', '.mao-browser', 'live.json'),
      JSON.stringify({ httpPort: oldSidecar.port, token: 'tok-99', pid: 4243 }),
    )
    fs.writeFileSync(
      path.join(runtimeDir, '77', '.mao-browser', 'live.json'),
      JSON.stringify({ httpPort: staleTokenSidecar.port, token: 'tok-77', pid: 4244 }),
    )
    const { runtime, ipc, mainWindowSends, menuShortcutCalls } = setupRuntime(runtimeDir)

    // LOCAL：新 sidecar（200）→ 'ok'，payload 原样到达 /input；能力标记随快照下发（P2-1）
    runtime.attachLocalSession(88)
    await sleep(300)
    sidecar.emit('browser_live_started', { width: 800, height: 600, pageUrl: 'https://a.com', control: true })
    await sleep(100)
    const payload = { targetId: 'T1', events: [{ type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }] }
    const ok = await ipc.handlers['browser-live-input'](null, { sessionId: 88, payload })
    assert.strictEqual(ok, 'ok')
    await sleep(200)
    assert.strictEqual(sidecar.inputRequests.length, 1)
    assert.deepStrictEqual(sidecar.inputRequests[0], payload)
    const snapshot = ipc.handlers['browser-live-get-state']()
    assert.strictEqual(snapshot.sessions['88'].startedControl, true, 'control 能力随快照下发（刷新后入口恢复）')

    // LOCAL：旧 sidecar（404 无 /input 路由）→ 'unsupported'（renderer 关闭交互入口）
    runtime.attachLocalSession(99)
    await sleep(300)
    const unsupported = await ipc.handlers['browser-live-input'](null, { sessionId: 99, payload })
    assert.strictEqual(unsupported, 'unsupported')

    // LOCAL：403 = token 失配（sidecar 重启换 token）→ 按丢批处理 'ok'，不误报版本过旧（P2-6）
    runtime.attachLocalSession(77)
    await sleep(300)
    const stale = await ipc.handlers['browser-live-input'](null, { sessionId: 77, payload })
    assert.strictEqual(stale, 'ok')

    // CLOUD（无 LOCAL 出口）：转请主窗 renderer 发 WS 帧（与 stop-relay 同范式）
    const relayed = await ipc.handlers['browser-live-input'](null, { sessionId: 22, payload })
    assert.strictEqual(relayed, 'ok')
    const relay = mainWindowSends.find((s) => s.channel === 'browser-live-input-relay')
    assert.ok(relay, 'cloud input should be relayed to renderer WS')
    assert.strictEqual(relay.data.sessionId, 22)
    assert.deepStrictEqual(relay.data.payload, payload)

    // 协作键盘捕获：overlay 聚焦 → 主窗屏蔽菜单加速键；失焦 → 恢复
    ipc.onHandlers['browser-live-collab-keys'](null, { active: true })
    ipc.onHandlers['browser-live-collab-keys'](null, { active: false })
    assert.deepStrictEqual(menuShortcutCalls, [true, false])

    runtime.shutdown()
  } finally {
    await sidecar.close()
    await oldSidecar.close()
    await staleTokenSidecar.close()
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
