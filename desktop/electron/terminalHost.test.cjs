'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')
const {
  TerminalHost,
  sliceUtf8,
  userIdFromToken,
  detectShell,
  toWsUrl,
  ensurePtyHelpersExecutable,
  HOST_FRAME_MAX_BYTES,
  DROPPED_NOTICE,
} = require('./terminalHost.cjs')

/** 假 node-pty：spawn 返回可手工驱动 data/exit 的进程。 */
class FakePty {
  constructor(options) {
    this.options = options
    this.written = []
    this.resized = []
    this.killed = false
    this.dataCb = null
    this.exitCb = null
  }
  onData(cb) { this.dataCb = cb }
  onExit(cb) { this.exitCb = cb }
  write(data) { this.written.push(data) }
  resize(cols, rows) { this.resized.push({ cols, rows }) }
  kill() { this.killed = true }
  emit(data) { this.dataCb?.(data) }
  exit(exitCode = 0) { this.exitCb?.({ exitCode }) }
}

/** 假 WebSocket：记录发送的帧，测试直接调用 host 的入站处理。 */
class FakeWebSocket {
  static instances = []
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = 1 // open
    this.bufferedAmount = 0
    this.sent = []
    this.closedWith = null
    FakeWebSocket.instances.push(this)
  }
  on(event, cb) {
    if (event === 'open') this.openCb = cb
    if (event === 'close') this.closeCb = cb
    if (event === 'message') this.messageCb = cb
  }
  send(payload) {
    this.sent.push(payload)
    if (this.sent.join('').length > 2_000_000) this.bufferedAmount = this.sent.join('').length
  }
  close(code, reason) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closedWith = { code, reason }
    this.closeCb?.(code)
  }
  emitOpen() { this.openCb?.() }
  /** 直接派发一帧（对象形式）。 */
  receive(frame) { this.messageCb?.(Buffer.from(JSON.stringify(frame))) }
  frames(type) {
    return this.sent
      .map((s) => { try { return JSON.parse(s) } catch { return null } })
      .filter((f) => f && f.type === type)
  }
}

function makeHost(tmp, overrides = {}) {
  const logs = []
  const env = { ...process.env, TERM: 'dumb', MAO_TOKEN: 'tok-1' }
  const host = new TerminalHost({
    apiBaseUrl: () => 'http://localhost:9080/api',
    readAuth: () => ({ token: overrides.token ?? 'header.payload.sig', refreshToken: null }),
    getDeviceId: () => 'dev-1',
    buildEnv: async () => env,
    WebSocketImpl: FakeWebSocket,
    ptyImpl: { spawn: (shell, args, opts) => new FakePty({ shell, args, ...opts }) },
    log: (level, msg) => logs.push(`${level} ${msg}`),
    heartbeatIntervalMs: 60_000,
    ...overrides.deps,
  })
  return { host, logs, env, tmp }
}

/** 起 host 并把 fake socket 推到 connected(active)。 */
function startConnected(host, role = 'active') {
  void host.connect().catch(() => {})
  const socket = FakeWebSocket.instances.at(-1)
  socket.emitOpen()
  socket.receive({ type: 'connected', userId: 7, role })
  return socket
}

test('sliceUtf8：切点落在 UTF-8 字符边界且拼接无损（按数据预算 32KB 切）', () => {
  const text = 'a中b😀c'.repeat(50_000)
  const chunks = sliceUtf8(text, HOST_DATA_CHUNK_HELPER)
  assert.equal(chunks.join(''), text)
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= HOST_DATA_CHUNK_HELPER)
    assert.ok(!chunk.includes('\uFFFD'))
  }
})

test('userIdFromToken / detectShell / toWsUrl', () => {
  const token = `header.${Buffer.from(JSON.stringify({ userId: 42 })).toString('base64url')}.sig`
  assert.equal(userIdFromToken(token), 42)
  assert.equal(userIdFromToken('garbage'), null)
  process.env.SHELL = '/bin/fish'
  assert.equal(detectShell('darwin'), '/bin/fish')
  delete process.env.SHELL
  assert.equal(detectShell('darwin'), '/bin/zsh')
  assert.equal(detectShell('win32'), '/bin/bash')
  assert.equal(toWsUrl('https://mao.example.com/api'), 'wss://mao.example.com/api/ws/terminal-host')
})

test('open：目录不存在回 CWD_MISSING 不 spawn；目录存在回 opened 且 TERM 覆盖为 xterm-256color', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-terminal-host-'))
  const { host } = makeHost(tmp)
  const socket = startConnected(host)

  socket.receive({ type: 'open', terminalId: 't1', cwd: path.join(tmp, 'gone'), cols: 100, rows: 30 })
  await waitFor(() => socket.frames('open_failed').length === 1)
  assert.deepEqual(socket.frames('open_failed')[0], { type: 'open_failed', terminalId: 't1', code: 'CWD_MISSING' })
  assert.equal(host.terminalIds().length, 0)

  const workdir = fs.mkdtempSync(path.join(tmp, 'ws-'))
  socket.receive({ type: 'open', terminalId: 't2', cwd: workdir, cols: 100, rows: 30 })
  await waitFor(() => socket.frames('opened').length === 1)
  const opened = socket.frames('opened')[0]
  assert.equal(opened.terminalId, 't2')
  assert.equal(opened.shell, detectShell(process.platform))
  assert.equal(opened.cwd, workdir)
  const pty = host.terminals.get('t2').pty
  assert.equal(pty.options.env.TERM, 'xterm-256color')
  assert.equal(pty.options.env.MAO_TOKEN, 'tok-1')
  assert.equal(pty.options.cols, 100)
  host.shutdown()
})

test('output：按 256KB 切片；bufferedAmount 超限丢帧并在下一片前补提示', () => {
  const { host } = makeHost()
  const socket = startConnected(host)
  host.terminals.set('t1', { pty: new FakePty({}), shell: '/bin/zsh', cwd: '/tmp' })
  const pty = host.terminals.get('t1').pty
  // handleOpen 注册的 onData 链：PTY 输出 → sendOutput（这里手工接上）
  pty.onData((d) => host.sendOutput('t1', d))

  pty.emit('hello')
  assert.equal(socket.frames('output').at(-1).data, 'hello')

  // 大输出：按 256KB 边界切成多帧，拼接无损
  const big = '中'.repeat(90_000)
  const beforeBig = socket.frames('output').length
  pty.emit(big)
  const outputs = socket.frames('output').slice(beforeBig)
  assert.ok(outputs.length >= 2)
  assert.equal(outputs.map((f) => f.data).join(''), big)

  // 背压：bufferedAmount 超过 1MB 丢帧（不新增帧）；恢复后先补一行提示
  socket.bufferedAmount = 1024 * 1024 + 1
  const beforeDropped = socket.frames('output').length
  pty.emit('dropped chunk')
  assert.equal(socket.frames('output').length, beforeDropped)
  socket.bufferedAmount = 0
  pty.emit('recovered')
  const lastTwo = socket.frames('output').slice(-2)
  assert.equal(lastTwo.at(-2).data, DROPPED_NOTICE)
  assert.equal(lastTwo.at(-1).data, 'recovered')
  host.shutdown()
})

test('input/resize/kill 只作用于中继 map；未知 id 忽略', () => {
  const { host } = makeHost()
  const socket = startConnected(host)
  const pty = new FakePty({})
  host.terminals.set('t1', { pty, shell: '/bin/zsh', cwd: '/tmp' })

  socket.receive({ type: 'input', terminalId: 't1', data: 'ls\r\n' })
  socket.receive({ type: 'input', terminalId: 't-unknown', data: 'rm -rf /' })
  socket.receive({ type: 'resize', terminalId: 't1', cols: 120, rows: 40 })
  assert.deepEqual(pty.written, ['ls\r\n'])
  assert.deepEqual(pty.resized, [{ cols: 120, rows: 40 }])

  socket.receive({ type: 'kill', terminalId: 't1', reason: 'CLOSE' })
  assert.ok(pty.killed)
  assert.equal(host.terminalIds().length, 0)
  // kill 后服务器会收到 exit 帧（本端统一收敛）
  assert.equal(socket.frames('exit').at(-1).terminalId, 't1')
  host.shutdown()
})

test('auth-set-tokens：账号切换（userId 变化）杀掉全部中继 PTY', () => {
  const { host } = makeHost()
  startConnected(host)
  const pty = new FakePty({})
  host.terminals.set('t1', { pty, shell: '/bin/zsh', cwd: '/tmp' })
  host.currentUserId = 7

  const token42 = `header.${Buffer.from(JSON.stringify({ userId: 42 })).toString('base64url')}.sig`
  host.onTokensWritten(token42)
  assert.ok(pty.killed)
  assert.equal(host.terminalIds().length, 0)
  assert.equal(host.currentUserId, 42)

  // 同账号刷新 token：不杀
  const pty2 = new FakePty({})
  host.terminals.set('t2', { pty: pty2, shell: '/bin/zsh', cwd: '/tmp' })
  host.onTokensWritten(token42)
  assert.ok(!pty2.killed)
  host.shutdown()
})

test('通过 handleOpen 注册的 PTY 退出会上送 exit 并移除', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-terminal-host-'))
  const { host } = makeHost(tmp)
  const socket = startConnected(host)
  const workdir = fs.mkdtempSync(path.join(tmp, 'ws-'))
  socket.receive({ type: 'open', terminalId: 't1', cwd: workdir })
  await waitFor(() => socket.frames('opened').length === 1)
  host.terminals.get('t1').pty.exit(3)
  assert.equal(socket.frames('exit').at(-1).terminalId, 't1')
  assert.equal(socket.frames('exit').at(-1).exitCode, 3)
  assert.equal(host.terminalIds().length, 0)
  host.shutdown()
})

test('shutdown：杀掉全部中继 PTY 并关闭 socket', () => {
  const { host } = makeHost()
  const socket = startConnected(host)
  const pty = new FakePty({})
  host.terminals.set('t1', { pty, shell: '/bin/zsh', cwd: '/tmp' })
  host.shutdown()
  assert.ok(pty.killed)
  assert.equal(socket.closedWith?.code, 1000)
  assert.equal(host.terminalIds().length, 0)
})

test('ensurePtyHelpersExecutable：缺 x 位补上且幂等；已有 x 位不动', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-pty-perms-')))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'node-pty', main: './lib/index.js' }))
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  const entry = path.join(root, 'lib', 'index.js')
  fs.writeFileSync(entry, '')
  const prebuild = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`)
  fs.mkdirSync(prebuild, { recursive: true })
  const helper = path.join(prebuild, 'spawn-helper')
  fs.writeFileSync(helper, '#!/bin/sh\n')
  fs.chmodSync(helper, 0o644)

  ensurePtyHelpersExecutable(entry)
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755)
  // 幂等：再次调用保持 0755
  ensurePtyHelpersExecutable(entry)
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755)

  // 已有 x 位的不改动
  const other = path.join(prebuild, 'winpty-agent.exe')
  fs.writeFileSync(other, '')
  fs.chmodSync(other, 0o755)
  ensurePtyHelpersExecutable(entry)
  assert.equal(fs.statSync(other).mode & 0o777, 0o755)
})

test('ensurePtyHelpersExecutable：空 / 不存在入口静默不抛', () => {
  assert.doesNotThrow(() => ensurePtyHelpersExecutable(''))
  assert.doesNotThrow(() => ensurePtyHelpersExecutable(path.join(os.tmpdir(), 'mao-no-such-pty', 'lib', 'index.js')))
})

// ---- helpers ----

const SOCKET_BACKPRESSURE_HELPER = 1024 * 1024 + 1
// 与 electron/terminalHost.cjs 的 HOST_DATA_CHUNK_BYTES 同值（数据切片预算）
const HOST_DATA_CHUNK_HELPER = 32 * 1024

function waitFor(cond, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}
