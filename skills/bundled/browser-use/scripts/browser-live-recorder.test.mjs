/**
 * browser-live-recorder 纯函数回归（技术方案 2026-11-22 §3/§8）：场目录布局、节流、
 * 上限截断、崩溃未结算、WS 重连拆场、零帧 stopped、初始化失败不外抛。
 * 本地跑 `node --test browser-live-recorder.test.mjs`（与 browser_cli_lib.test.mjs 同模式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder } from './browser-live-recorder.mjs';

function tmpLiveDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mao-recorder-'));
  return path.join(root, '.mao-browser');
}

function readManifest(liveDir, liveId) {
  return JSON.parse(readFileSync(path.join(liveDir, 'replay', liveId, 'manifest.json'), 'utf8'));
}

function readTimeline(liveDir, liveId) {
  const raw = readFileSync(path.join(liveDir, 'replay', liveId, 'timeline.ndjson'), 'utf8');
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const JPEG_A = Buffer.from('fake-jpeg-a').toString('base64');
const JPEG_B = Buffer.from('fake-jpeg-b').toString('base64');

function frame(seq, ts, jpeg = JPEG_A, extra = {}) {
  return { seq, ts, jpeg, width: 640, height: 480, pageUrl: 'https://example.com/a', cliSession: 'default', ...extra };
}

test('完整场：started + 帧 + stopped 结算 manifest，目录布局与帧字节正确', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 0, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  rec.onFrame(frame(2, 1100, JPEG_B, { pageUrl: 'https://example.com/b' }));
  rec.onStopped('user_stop');

  const dir = path.join(liveDir, 'replay', 'L1000');
  assert.equal(existsSync(dir), true);
  assert.deepEqual(readFileSync(path.join(dir, 'f1.jpg')), Buffer.from('fake-jpeg-a'));
  assert.deepEqual(readFileSync(path.join(dir, 'f2.jpg')), Buffer.from('fake-jpeg-b'));

  const manifest = readManifest(liveDir, 'L1000');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.liveId, 'L1000');
  assert.equal(manifest.sessionId, '42');
  assert.equal(manifest.startedAt, 1000);
  assert.equal(manifest.endedAt, 1100);
  assert.equal(manifest.durationMs, 100);
  assert.equal(manifest.frameCount, 2);
  assert.equal(manifest.truncated, false);
  assert.equal(manifest.approxBytes, Buffer.from('fake-jpeg-a').length + Buffer.from('fake-jpeg-b').length);
  assert.deepEqual(manifest.urls.sort(), ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(manifest.cliSessions, ['default']);

  const rows = readTimeline(liveDir, 'L1000');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[0].bytes, Buffer.from('fake-jpeg-a').length);
  assert.equal(rows[1].file, 'f2.jpg');
});

test('录制节流：距上一录帧 <1s 的帧只直播不落盘', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 1000, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  rec.onFrame(frame(2, 1500)); // 500ms 间隔 → 跳过
  rec.onFrame(frame(3, 2100)); // 1100ms 间隔 → 落盘
  rec.onStopped();
  assert.equal(readTimeline(liveDir, 'L1000').length, 2);
  assert.equal(readManifest(liveDir, 'L1000').frameCount, 2);
  assert.equal(existsSync(path.join(liveDir, 'replay', 'L1000', 'f2.jpg')), false);
});

test('单场上限：超限截断停录本场，manifest.truncated=true，后续帧不落盘', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 0, maxBytes: 20, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000)); // 11 bytes
  rec.onFrame(frame(2, 1100)); // 11 bytes → 累计超 20 → 截断
  rec.onFrame(frame(3, 1200)); // 已停录
  rec.onStopped(); // 已停录后的 stopped 不再变更

  const manifest = readManifest(liveDir, 'L1000');
  assert.equal(manifest.truncated, true);
  assert.equal(manifest.endedAt, 1000); // 以最后一录帧 ts 结算（被截断帧未落盘）
  assert.equal(manifest.frameCount, 1);
  assert.equal(readTimeline(liveDir, 'L1000').length, 1);
  assert.equal(existsSync(path.join(liveDir, 'replay', 'L1000', 'f3.jpg')), false);
});

test('崩溃未结算：不发 stopped 时 manifest.endedAt 保持 null（逐帧刷新仍有实时计数）', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 0, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  // 不调用 onStopped，模拟 timeout_2h / runner_exit / 硬崩溃
  const manifest = readManifest(liveDir, 'L1000');
  assert.equal(manifest.endedAt, null);
  assert.equal(manifest.durationMs, null);
  assert.equal(manifest.frameCount, 1);
});

test('WS 重连拆场：onStarted 期间已有进行中场，先结算旧场再开新目录', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 0, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  rec.onStarted({ ts: 5000 }); // host 闩锁复位后补发 started（无 stopped）
  rec.onFrame(frame(2, 5000, JPEG_B));

  const oldManifest = readManifest(liveDir, 'L1000');
  assert.equal(oldManifest.endedAt, 1000); // 以旧场最后一帧 ts 结算
  const newManifest = readManifest(liveDir, 'L5000');
  assert.equal(newManifest.startedAt, 5000);
  assert.equal(newManifest.endedAt, null);
  assert.equal(readTimeline(liveDir, 'L1000').length, 1);
  assert.equal(readTimeline(liveDir, 'L5000').length, 1);
  assert.deepEqual(readFileSync(path.join(liveDir, 'replay', 'L5000', 'f2.jpg')), Buffer.from('fake-jpeg-b'));
});

test('零帧 stopped：未 started 的 stopped no-op；零帧场结算时删除空目录', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', log: () => {} });
  rec.onStopped('browser_exit'); // 未 started
  rec.onStarted({ ts: 1000 });
  rec.onStopped('browser_exit'); // 零帧结算 → 删目录
  rec.onStopped('browser_exit'); // 重复 stopped
  const replayRoot = path.join(liveDir, 'replay');
  assert.equal(existsSync(replayRoot), true);
  assert.equal(readdirSync(replayRoot).length, 0);
});

test('初始化失败（liveDir 不可创建）：不外抛、不落盘，直播链路不受影响', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mao-recorder-bad-'));
  // parent 是文件 → mkdir 必然失败
  const fileAsParent = path.join(root, 'blocker');
  writeFileSync(fileAsParent, 'x');
  const liveDir = path.join(fileAsParent, '.mao-browser');
  const logs = [];
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 0, log: (...p) => logs.push(p.join(' ')) });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  rec.onStopped();
  assert.equal(logs.length > 0, true);
});

test('liveId 同毫秒碰撞顺延：目录已存在时 alloc 下一毫秒', () => {
  const liveDir = tmpLiveDir();
  mkdirSync(path.join(liveDir, 'replay', 'L1000'), { recursive: true });
  const rec = createRecorder({ liveDir, sessionId: '42', minIntervalMs: 0, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  rec.onStopped();
  assert.equal(existsSync(path.join(liveDir, 'replay', 'L1001', 'manifest.json')), true);
});

test('enabled=false：所有入口 no-op', () => {
  const liveDir = tmpLiveDir();
  const rec = createRecorder({ liveDir, sessionId: '42', enabled: false, minIntervalMs: 0, log: () => {} });
  rec.onStarted({ ts: 1000 });
  rec.onFrame(frame(1, 1000));
  rec.onStopped();
  assert.equal(existsSync(path.join(liveDir, 'replay')), false);
});
