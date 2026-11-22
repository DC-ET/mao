'use strict'

/**
 * 浏览器直播回放读取回归（V202，技术方案 2026-11-22 §4.2）：场次列表 / timeline / 帧读取、
 * liveId/seq 白名单与 containment、未登录等非法入参、坏 manifest 容错。
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
      version: 1, liveId, sessionId: Number(liveId.slice(1)),
      startedAt: opts.startedAt ?? 1000, endedAt: opts.endedAt ?? 2000,
      frameCount: 1, durationMs: 1000, approxBytes: 6,
      cliSessions: ['default'], urls: [], truncated: opts.truncated ?? false,
    }))
  fs.writeFileSync(path.join(dir, 'timeline.ndjson'),
    JSON.stringify({ seq: 1, ts: 1000, pageUrl: 'https://e.com', width: 640, height: 480, bytes: 6, file: 'f1.jpg' }) + '\n'
    + '{"seq": 2, "ts": half-broken\n')
  fs.writeFileSync(path.join(dir, 'f1.jpg'), Buffer.from('jpeg-1'))
}

function runtimeFor(root) {
  return createBrowserLiveRuntime({ resolveSessionRuntimeDir: (sessionId) => path.join(root, String(sessionId)) })
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
