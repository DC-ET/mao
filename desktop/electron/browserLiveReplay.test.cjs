'use strict'

/**
 * 浏览器直播回放读取回归（V202，技术方案 2026-11-22 §4.2）：场次列表 / timeline / 帧读取、
 * liveId/seq 白名单与 containment、未登录等非法入参、坏 manifest 容错。
 * 跨会话本机扫描 replayListAll（技术方案 2026-11-27 §6.3）用例同收于此。
 * 与 browserLive.test.cjs 同模式：node --test 直载，零 Electron 依赖。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createBrowserLiveRuntime } = require('./browserLive.cjs')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mao-blivereplay-'))
}

function writeLive(root, sessionId, liveId, opts = {}) {
  const dir = path.join(root, String(sessionId), '.mao-browser', 'replay', liveId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), opts.brokenManifest
    ? '{"liveId": "half'
    : JSON.stringify({
      version: 1, liveId,
      // 落盘口径：sidecar 写 String(args.session)（字符串）；缺省按目录名推导
      sessionId: opts.manifestSessionId ?? String(sessionId),
      startedAt: opts.startedAt ?? Number(liveId.slice(1)),
      // endedAt 允许显式传 null（未结算场）：用 in 判定，勿让 ?? 把 null 兜成 2000
      endedAt: 'endedAt' in opts ? opts.endedAt : 2000,
      frameCount: 1, durationMs: 1000, approxBytes: 6,
      cliSessions: ['default'], urls: opts.urls ?? [], truncated: opts.truncated ?? false,
    }))
  fs.writeFileSync(path.join(dir, 'timeline.ndjson'),
    JSON.stringify({ seq: 1, ts: 1000, pageUrl: 'https://e.com', width: 640, height: 480, bytes: 6, file: 'f1.jpg' }) + '\n'
    + '{"seq": 2, "ts": half-broken\n')
  fs.writeFileSync(path.join(dir, 'f1.jpg'), Buffer.from('jpeg-1'))
}

function runtimeFor(root) {
  return createBrowserLiveRuntime({
    resolveSessionRuntimeDir: (sessionId) => path.join(root, String(sessionId)),
    resolveLocalRuntimeRoot: () => root,
  })
}

test('场次列表：倒序、未结算场保留、坏 manifest 跳过、非法会话空列表', () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  writeLive(root, 11, 'L5000', { endedAt: null, truncated: true, brokenManifest: true })
  writeLive(root, 11, 'L3000', { startedAt: 3000 })
  const rt = runtimeFor(root)
  assert.deepEqual(rt.replayList(11).map((s) => s.liveId), ['L3000', 'L1000'])
  assert.equal(rt.replayList(11)[0].liveId, 'L3000')
  assert.deepEqual(rt.replayList(0), [])
  assert.deepEqual(rt.replayList('abc'), [])
  assert.deepEqual(rt.replayList(99), [])
})

test('timeline：manifest + 容错帧索引；穿越 liveId / 非法 liveId 返回 null', () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  const rt = runtimeFor(root)
  const tl = rt.replayTimeline(11, 'L1000')
  assert.equal(tl.manifest.liveId, 'L1000')
  assert.deepEqual(tl.frames.map((f) => f.seq), [1]) // 半行跳过

  assert.equal(rt.replayTimeline(11, '../../11/.mao-browser/replay/L1000'), null)
  assert.equal(rt.replayTimeline(11, 'abc'), null)
  assert.equal(rt.replayTimeline(11, 'L9999'), null)
  assert.equal(rt.replayTimeline(0, 'L1000'), null)
})

test('帧读取：Buffer 内容正确；非法 seq / 越界 / 缺失返回 null', () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  const rt = runtimeFor(root)
  assert.equal(rt.replayFrame(11, 'L1000', 1).toString(), 'jpeg-1')
  assert.equal(rt.replayFrame(11, 'L1000', 2), null)
  assert.equal(rt.replayFrame(11, 'L1000', -1), null)
  assert.equal(rt.replayFrame(11, 'L1000', Number.NaN), null)
  assert.equal(rt.replayFrame(11, '../../x', 1), null)
})

test('registerIpc 挂载回放通道：invoke 直通同函数', async () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  const handlers = new Map()
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
  }
  runtimeFor(root).registerIpc(ipcMain)
  assert.equal((await handlers.get('browser-live-replay-list')(null, { sessionId: 11 })).length, 1)
  const tl = await handlers.get('browser-live-replay-timeline')(null, { sessionId: 11, liveId: 'L1000' })
  assert.equal(tl.manifest.liveId, 'L1000')
  const frame = await handlers.get('browser-live-replay-frame')(null, { sessionId: 11, liveId: 'L1000', seq: 1 })
  assert.equal(frame.toString(), 'jpeg-1')
})

// ---------- 跨会话本机扫描 replayListAll（技术方案 2026-11-27 §6.3） ----------

test('replayListAll：数字会话目录 + L\\d+ 白名单，按 startedAt 倒序，pageUrl 取 urls[0]', () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000', { urls: ['https://a.example.com', 'https://b.example.com'] })
  writeLive(root, 11, 'L5000', { endedAt: null, truncated: true })
  writeLive(root, 12, 'L3000')
  // 非数字会话目录、非 L\d+ 场次目录一律忽略
  fs.mkdirSync(path.join(root, 'abc', '.mao-browser', 'replay', 'L9000'), { recursive: true })
  fs.mkdirSync(path.join(root, '13', '.mao-browser', 'replay', 'Lnotnum'), { recursive: true })
  fs.mkdirSync(path.join(root, '14', '.mao-browser', 'replay', 'L7000', 'nested'), { recursive: true })
  const rt = runtimeFor(root)
  const { rows, truncated } = rt.replayListAll(null, null)
  assert.deepEqual(rows.map((r) => [r.sessionId, r.liveId]), [[11, 'L5000'], [12, 'L3000'], [11, 'L1000']])
  assert.equal(rows[0].endedAt, null)
  assert.equal(rows[0].truncated, true)
  assert.equal(rows[2].pageUrl, 'https://a.example.com')
  // 行结构：录制字段齐全，无会话标题 / Agent（由渲染层补齐）
  assert.deepEqual(Object.keys(rows[2]).sort(), [
    'approxBytes', 'durationMs', 'endedAt', 'frameCount', 'liveId', 'pageUrl', 'sessionId', 'startedAt', 'truncated',
  ])
  // 未触上限：truncated 为 false（渲染层据此不弹「结果不完整」提示）
  assert.equal(truncated, false)
})

test('replayListAll：时间窗按 liveId 时间戳闭区间过滤；非数字入参按无界；from>to 空列表', () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  writeLive(root, 11, 'L3000')
  writeLive(root, 11, 'L5000')
  const rt = runtimeFor(root)
  assert.deepEqual(rt.replayListAll(1000, 3000).rows.map((r) => r.liveId), ['L3000', 'L1000'])
  assert.deepEqual(rt.replayListAll(2000, 4000).rows.map((r) => r.liveId), ['L3000'])
  assert.deepEqual(rt.replayListAll(4000, null).rows.map((r) => r.liveId), ['L5000'])
  // NaN / 非数字 / undefined 都按无界处理（不抛错也不丢数据）
  assert.equal(rt.replayListAll(Number.NaN, 'x').rows.length, 3)
  assert.equal(rt.replayListAll(undefined, undefined).rows.length, 3)
  // 窗口反转直接空列表
  assert.deepEqual(rt.replayListAll(5000, 1000), { rows: [], truncated: false })
})

test('replayListAll：坏 manifest 跳过；manifest.sessionId（落盘是字符串）与目录名不一致跳过', () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  writeLive(root, 11, 'L2000', { brokenManifest: true })
  // 目录 12 的 manifest 记的是别的会话：跨会话串场风险，跳过
  writeLive(root, 12, 'L3000', { manifestSessionId: '99' })
  // 字符串一致（含前导零之外的普通形态）保留
  writeLive(root, 13, 'L4000', { manifestSessionId: '13' })
  const rt = runtimeFor(root)
  assert.deepEqual(rt.replayListAll(null, null).rows.map((r) => r.liveId), ['L4000', 'L1000'])
})

test('replayListAll：单次上限 2000 场，倒序扫描保留较新的场次并置 truncated', () => {
  const root = tmpRoot()
  const total = 2005
  for (let i = 1; i <= total; i++) writeLive(root, 11, `L${i}`)
  const rt = runtimeFor(root)
  const { rows, truncated } = rt.replayListAll(null, null)
  assert.equal(rows.length, 2000)
  assert.equal(rows[0].liveId, 'L2005')
  assert.equal(rows[rows.length - 1].liveId, 'L6')
  assert.equal(truncated, true)
})

test('replayListAll：会话目录枚举达上限即停并置 truncated（主进程同步 IO 不无界增长）', () => {
  const root = tmpRoot()
  // 每个目录各 1 场：行数远低于 2000，截断只能来自会话目录枚举上限
  for (let i = 1; i <= 2500; i++) writeLive(root, 10000 + i, 'L1000')
  const rt = runtimeFor(root)
  const { rows, truncated } = rt.replayListAll(null, null)
  assert.equal(rows.length, 2000)
  assert.equal(truncated, true)
  // 枚举按 sessionId 倒序：保留较新的会话目录
  assert.equal(rows[0].sessionId, 12500)
})

test('replayListAll：根目录不存在 / 未注入 resolveLocalRuntimeRoot 均返回空扫描', () => {
  const missing = path.join(os.tmpdir(), `mao-blivereplay-missing-${Date.now()}`)
  assert.deepEqual(runtimeFor(missing).replayListAll(null, null), { rows: [], truncated: false })
  const noRoot = createBrowserLiveRuntime({ resolveSessionRuntimeDir: () => '/nonexistent' })
  assert.deepEqual(noRoot.replayListAll(null, null), { rows: [], truncated: false })
})

test('registerIpc 挂载跨会话扫描通道：invoke 直通同函数，缺 payload 不抛错', async () => {
  const root = tmpRoot()
  writeLive(root, 11, 'L1000')
  const handlers = new Map()
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }
  runtimeFor(root).registerIpc(ipcMain)
  const scan = await handlers.get('browser-live-replay-list-all')(null, { from: null, to: null })
  assert.equal(scan.rows.length, 1)
  assert.equal(scan.rows[0].sessionId, 11)
  assert.equal(scan.truncated, false)
  const unbounded = await handlers.get('browser-live-replay-list-all')(null, undefined)
  // 缺 payload 不抛错：from/to 均缺省 → 按无界窗扫描，与显式 (null, null) 同结果
  assert.deepEqual(unbounded, scan)
})
