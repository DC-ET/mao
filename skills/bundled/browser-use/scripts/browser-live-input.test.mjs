/**
 * browser-live-input 纯函数回归（技术方案 2026-11-27 §4/§5/§13）：校验矩阵、
 * 路由（targetId 命中 / lastActive 回退 / 无页）、限速（批原子拒绝 + 令牌补充）、
 * CDP 注入计划形状、定向提帧率、日志纪律（D7：只允许计数，不得含坐标/文本内容）。
 * 本地跑 `node --test browser-live-input.test.mjs`（与 browser-live-recorder.test.mjs 同模式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_MAX_EVENTS,
  createInputApplier,
  createInputRateLimiter,
  frameIntervalFor,
  inputDispatchPlan,
  validInputBatch,
} from './browser-live-input.mjs';

function mkPage(sessionId = 'SID-P1', overrides = {}) {
  return { sessionId, url: 'https://example.com', lastSent: 0, castOn: true, ...overrides };
}

function mkBrowsers(pagesBySession = { default: { T1: mkPage() } }) {
  const browsers = new Map();
  for (const [cliSession, pages] of Object.entries(pagesBySession)) {
    const map = new Map();
    for (const [targetId, page] of Object.entries(pages)) map.set(targetId, page);
    browsers.set(cliSession, { port: 1, ws: null, alive: true, pages: map, deadTicks: 0, stopping: false, nextId: 1 });
  }
  return browsers;
}

function mkApplier({ browsers = mkBrowsers(), lastActive = { cliSession: 'default', targetId: 'T1' } } = {}) {
  const calls = [];
  const logs = [];
  const applyInput = createInputApplier({
    browsers,
    getLastActiveFrame: () => lastActive,
    cdpCall: (entry, method, params, sessionId) => calls.push({ entry, method, params, sessionId }),
    rateLimiter: null,
    log: (...parts) => logs.push(parts.join(' ')),
  });
  return { applyInput, calls, logs, browsers };
}

// ---------- 校验矩阵（§4 约束） ----------

test('校验：合法批通过并规整 targetId', () => {
  const batch = validInputBatch({
    targetId: 'T1',
    events: [
      { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 2 },
      { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: -120 },
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'char', text: 'a' },
      { type: 'insertText', text: '你好' },
    ],
  });
  assert.equal(batch.targetId, 'T1');
  assert.equal(batch.events.length, 5);
  // targetId 缺省 → null（回退路由）
  assert.equal(validInputBatch({ events: [{ type: 'char', text: 'x' }] }).targetId, null);
});

test('校验：非法批整批拒绝（空/超限/坏形状）', () => {
  assert.equal(validInputBatch(null), null);
  assert.equal(validInputBatch({}), null);
  assert.equal(validInputBatch({ events: [] }), null);
  assert.equal(validInputBatch({ events: 'nope' }), null);
  const tooMany = Array.from({ length: INPUT_MAX_EVENTS + 1 }, () => ({ type: 'char', text: 'a' }));
  assert.equal(validInputBatch({ events: tooMany }), null);
  assert.equal(validInputBatch({ targetId: 123, events: [{ type: 'char', text: 'a' }] }), null);
  assert.equal(validInputBatch({ targetId: 'x'.repeat(129), events: [{ type: 'char', text: 'a' }] }), null);
  assert.equal(validInputBatch({ events: [null] }), null);
  assert.equal(validInputBatch({ events: [{ type: 'teleport', x: 1, y: 1 }] }), null);
});

test('校验：坐标/按键/文本逐字段矩阵', () => {
  const withEvent = (e) => validInputBatch({ events: [e] });
  // 坐标：NaN / 超界
  for (const xy of [NaN, Infinity, -101, 100001, '10']) {
    assert.equal(withEvent({ type: 'mouseMoved', x: xy, y: 5 }), null, `x=${xy}`);
  }
  assert.notEqual(withEvent({ type: 'mouseMoved', x: -100, y: 100000 }), null, '边界值合法');
  // button 白名单
  assert.equal(withEvent({ type: 'mousePressed', x: 1, y: 1, button: 'side', clickCount: 1 }), null);
  // clickCount 范围
  assert.equal(withEvent({ type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 0 }), null);
  assert.equal(withEvent({ type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 4 }), null);
  assert.notEqual(withEvent({ type: 'mouseReleased', x: 1, y: 1, button: 'middle', clickCount: 3 }), null);
  // wheel delta 有限且有界
  assert.equal(withEvent({ type: 'mouseWheel', x: 1, y: 1, deltaX: NaN, deltaY: 0 }), null);
  assert.equal(withEvent({ type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: 200000 }), null);
  // vkc 范围
  assert.equal(withEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: -1 }), null);
  assert.equal(withEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 0x10000 }), null);
  assert.equal(withEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: '65' }), null);
  assert.notEqual(withEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 0 }), null);
  // modifiers 位掩码 ≤ 0xFF
  assert.equal(withEvent({ type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0x100 }), null);
  assert.equal(withEvent({ type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 1.5 }), null);
  assert.notEqual(withEvent({ type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0xFF }), null);
  // 文本：非空、长度上限
  assert.equal(withEvent({ type: 'char', text: '' }), null);
  assert.equal(withEvent({ type: 'char', text: 42 }), null);
  assert.equal(withEvent({ type: 'insertText', text: 'x'.repeat(1001) }), null);
  assert.notEqual(withEvent({ type: 'insertText', text: 'x'.repeat(1000) }), null);
  // key/code 形状
  assert.equal(withEvent({ type: 'keyDown', key: 'x'.repeat(65), code: 'KeyX', windowsVirtualKeyCode: 88 }), null);
  assert.equal(withEvent({ type: 'keyDown', key: 'a', code: 5, windowsVirtualKeyCode: 65 }), null);
});

// ---------- 路由（§5.2） ----------

test('路由：targetId 命中优先，跨 cliSession 也能命中', () => {
  const browsers = mkBrowsers({ a: { TA: mkPage('SID-A') }, b: { TB: mkPage('SID-B') } });
  const { applyInput, calls } = mkApplier({ browsers });
  const n = applyInput({ targetId: 'TB', events: [{ type: 'mouseMoved', x: 1, y: 2 }] });
  assert.equal(n, 1);
  assert.equal(calls[0].sessionId, 'SID-B');
});

test('路由：targetId 未命中回退最近出帧页', () => {
  const browsers = mkBrowsers({ a: { TA: mkPage('SID-A') }, b: { TB: mkPage('SID-B') } });
  const { applyInput, calls } = mkApplier({ browsers, lastActive: { cliSession: 'b', targetId: 'TB' } });
  applyInput({ targetId: 'NOPE', events: [{ type: 'char', text: 'a' }] });
  assert.equal(calls[0].sessionId, 'SID-B');
});

test('路由：targetId 与 lastActive 双未命中 → 忽略（0 注入）', () => {
  const browsers = mkBrowsers({ a: { TA: mkPage('SID-A') } });
  const miss1 = mkApplier({ browsers, lastActive: null });
  assert.equal(miss1.applyInput({ events: [{ type: 'char', text: 'a' }] }), 0);
  // lastActive 指向已消失的页（浏览器退出）：同样忽略
  const miss2 = mkApplier({ browsers, lastActive: { cliSession: 'gone', targetId: 'TX' } });
  assert.equal(miss2.applyInput({ events: [{ type: 'char', text: 'a' }] }), 0);
  assert.equal(miss2.calls.length, 0);
});

test('路由：非法批不产生任何 CDP 调用（先校验后路由）', () => {
  const { applyInput, calls } = mkApplier();
  assert.equal(applyInput({ targetId: 'T1', events: [{ type: 'mouseMoved', x: NaN, y: 1 }] }), 0);
  assert.equal(calls.length, 0);
});

// ---------- 限速（§5.2：批原子拒绝） ----------

test('限速：令牌不足整批拒绝（不部分注入，避免按压卡死）', () => {
  const t0 = 1_000_000;
  const rateLimiter = createInputRateLimiter({ now: () => t0 });
  const browsers = mkBrowsers();
  const calls = [];
  const applyInput = createInputApplier({
    browsers,
    getLastActiveFrame: () => ({ cliSession: 'default', targetId: 'T1' }),
    cdpCall: (entry, method, params, sessionId) => calls.push({ method, params, sessionId }),
    rateLimiter,
    log: () => {},
    now: () => t0,
  });
  const events = Array.from({ length: 8 }, (_, i) => ({ type: 'mouseMoved', x: i, y: i }));
  // 默认 burst=60：首批 8 事件 → 剩 52；再 6 批（48 事件）→ 剩 4
  assert.equal(applyInput({ events }), 8);
  for (let i = 0; i < 6; i++) assert.equal(applyInput({ events }), 8);
  // 第 8 批需 8 个令牌但只剩 4：整批拒绝，不部分注入（避免 mousedown 无 mouseup 的卡键）
  assert.equal(applyInput({ events }), 0);
  assert.equal(calls.length, 7 * 8, '拒绝批不得产生任何注入');
});

test('限速：令牌随时间补充恢复', () => {
  let t = 0;
  const rateLimiter = createInputRateLimiter({ ratePerSecond: 60, burst: 60, now: () => t });
  assert.equal(rateLimiter.allow('k', 60), true);
  assert.equal(rateLimiter.allow('k', 1), false);
  t = 1000; // 补满 60
  assert.equal(rateLimiter.allow('k', 60), true);
  // clear 清桶：清后立即满桶
  rateLimiter.clear('k');
  assert.equal(rateLimiter.allow('k', 60), true);
});

// ---------- 注入计划（CDP 命令形状） ----------

test('注入计划：mouse 系带 modifiers，keyDown 映射 rawKeyDown', () => {
  const press = inputDispatchPlan({ type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 2, modifiers: 10 });
  assert.equal(press.method, 'Input.dispatchMouseEvent');
  assert.deepEqual(press.params, { type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 2, modifiers: 10 });

  const move = inputDispatchPlan({ type: 'mouseMoved', x: 1, y: 2 });
  assert.equal(move.method, 'Input.dispatchMouseEvent');
  assert.equal(move.params.modifiers, undefined, 'mouseMoved 不带 modifiers（纯移动无组合语义）');

  const wheel = inputDispatchPlan({ type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: -120, modifiers: 2 });
  assert.deepEqual(wheel.params, { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: -120, modifiers: 2 });

  const down = inputDispatchPlan({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 });
  assert.equal(down.method, 'Input.dispatchKeyEvent');
  assert.equal(down.params.type, 'rawKeyDown');
  assert.equal(down.params.windowsVirtualKeyCode, 65);

  const up = inputDispatchPlan({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  assert.equal(up.params.type, 'keyUp');

  const ch = inputDispatchPlan({ type: 'char', text: '字' });
  assert.deepEqual(ch, { method: 'Input.dispatchKeyEvent', params: { type: 'char', text: '字' } });

  const ime = inputDispatchPlan({ type: 'insertText', text: '你好' });
  assert.deepEqual(ime, { method: 'Input.insertText', params: { text: '你好' } });
});

test('注入：事件按序注入到目标页 session，并置位 lastInputAt（定向提帧率）', () => {
  const page = mkPage('SID-P1');
  const browsers = mkBrowsers({ default: { T1: page } });
  const calls = [];
  const tNow = 5_000_000;
  const applyInput = createInputApplier({
    browsers,
    getLastActiveFrame: () => ({ cliSession: 'default', targetId: 'T1' }),
    cdpCall: (entry, method, params, sessionId) => calls.push({ method, params, sessionId }),
    rateLimiter: null,
    log: () => {},
    now: () => tNow,
  });
  applyInput({ targetId: 'T1', events: [
    { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 },
  ] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.sessionId === 'SID-P1'));
  assert.equal(page.lastInputAt, tNow, 'lastInputAt 置位供 frameIntervalFor 判定');
  assert.equal(frameIntervalFor(page, tNow + 1), 100, '输入活跃窗口内返回提帧间隔');
  assert.equal(frameIntervalFor(page, tNow + 5001), null, '窗口外回退基础间隔（null）');
});

// ---------- 日志纪律（D7：只允许计数，禁止坐标/文本内容） ----------

test('日志纪律：成功/限速日志只含计数与 target id，绝不含坐标与文本', () => {
  const page = mkPage();
  const browsers = mkBrowsers({ default: { T1: page } });
  let t = 0;
  const logs = [];
  const rateLimiter = createInputRateLimiter({ burst: 2, now: () => t });
  const applyInput = createInputApplier({
    browsers,
    getLastActiveFrame: () => ({ cliSession: 'default', targetId: 'T1' }),
    cdpCall: () => {},
    rateLimiter,
    log: (...parts) => logs.push(parts.join(' ')),
    now: () => t,
  });
  applyInput({ targetId: 'T1', events: [
    { type: 'mousePressed', x: 12345, y: 678, button: 'left', clickCount: 1 },
    { type: 'insertText', text: '秘密密码123' },
  ] });
  t = 1;
  applyInput({ targetId: 'T1', events: [{ type: 'char', text: 'x' }] }); // 令牌不足 → 限速日志
  const all = logs.join('\n');
  assert.ok(logs.length >= 2, '成功与限速各一条');
  assert.ok(!all.includes('12345') && !all.includes('678') && !all.includes('秘密'), '日志不得含坐标/文本');
  assert.ok(/events=/.test(all) && /cliSession=/.test(all), '日志只含计数与路由标识');
});
