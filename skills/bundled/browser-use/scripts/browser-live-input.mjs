/**
 * browser-live-input —— 协作输入注入核心（技术方案 2026-11-27 §5，零 npm 依赖）。
 *
 * 从 browser-live-host.mjs 抽出的可测模块：校验矩阵（§4 约束）、每 cliSession 限速桶、
 * 路由与 CDP 注入计划。host 注入 cdpCall / browsers 结构 / log 装配 applyInput；
 * 测试注入 fake 直接断言（方案 §13「直载模式」）。
 *
 * 隐私纪律（D7）：本模块与宿主的日志只允许事件计数与 CDP target id——
 * 绝不打坐标与文本内容（按键可能含密码）。
 */

export const INPUT_MAX_EVENTS = 32;
export const INPUT_MAX_TEXT = 1000;
/** 每 cliSession 事件数限速（§5.2）：客户端自限 ≤50/s（D12），这里是滥用防护 */
export const INPUT_RATE_PER_SEC = 60;
/** 输入活跃页的提帧间隔（§5.3 定向提帧率；基础间隔由 host 的 PAGE_MIN_INTERVAL_MS 提供） */
export const INPUT_FRAME_BOOST_INTERVAL_MS = 100;
/** 输入活跃判定窗口：窗口内目标页维持提帧率 */
export const INPUT_BOOST_WINDOW_MS = 5000;

const COORD_MIN = -100;
const COORD_MAX = 100000;
const VKC_MAX = 0xffff;
const MODS_MAX = 0xff;

function isCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= COORD_MIN && v <= COORD_MAX;
}

function isMods(v) {
  return v == null || (Number.isInteger(v) && v >= 0 && v <= MODS_MAX);
}

/**
 * 校验一整批（§4 约束，后端与 sidecar 双侧同矩阵）：非法返回 null（整批丢弃，静默——
 * 洪泛防护优先于可观测性）。合法返回规整后的 { targetId, events }。
 */
export function validInputBatch(data) {
  if (!data || typeof data !== 'object') return null;
  const events = data.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > INPUT_MAX_EVENTS) return null;
  let targetId = data.targetId;
  if (targetId == null) targetId = null;
  else if (typeof targetId !== 'string' || targetId.length > 128) return null;
  for (const e of events) {
    if (!e || typeof e !== 'object') return null;
    switch (e.type) {
      case 'mouseMoved':
        if (!isCoord(e.x) || !isCoord(e.y)) return null;
        break;
      case 'mousePressed':
      case 'mouseReleased':
        if (!isCoord(e.x) || !isCoord(e.y)) return null;
        if (e.button !== 'left' && e.button !== 'right' && e.button !== 'middle') return null;
        if (!Number.isInteger(e.clickCount) || e.clickCount < 1 || e.clickCount > 3) return null;
        if (!isMods(e.modifiers)) return null;
        break;
      case 'mouseWheel':
        if (!isCoord(e.x) || !isCoord(e.y)) return null;
        if (!Number.isFinite(e.deltaX) || Math.abs(e.deltaX) > COORD_MAX) return null;
        if (!Number.isFinite(e.deltaY) || Math.abs(e.deltaY) > COORD_MAX) return null;
        if (!isMods(e.modifiers)) return null;
        break;
      case 'keyDown':
      case 'keyUp':
        if (typeof e.key !== 'string' || e.key.length > 64) return null;
        if (typeof e.code !== 'string' || e.code.length > 64) return null;
        if (!Number.isInteger(e.windowsVirtualKeyCode)
          || e.windowsVirtualKeyCode < 0 || e.windowsVirtualKeyCode > VKC_MAX) return null;
        if (!isMods(e.modifiers)) return null;
        break;
      case 'char':
      case 'insertText':
        if (typeof e.text !== 'string' || e.text.length === 0 || e.text.length > INPUT_MAX_TEXT) return null;
        break;
      default:
        return null;
    }
  }
  return { targetId, events };
}

/**
 * 每 cliSession 令牌桶（§5.2）：取走 n 个令牌，桶不足整批拒绝（批原子性——
 * 不部分注入，避免半批事件造成 mousedown 无 mouseup 的按压卡死）。
 */
export function createInputRateLimiter({
  ratePerSecond = INPUT_RATE_PER_SEC,
  burst = INPUT_RATE_PER_SEC,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  return {
    allow(key, n) {
      const t = now();
      const b = buckets.get(key) ?? { tokens: burst, last: t };
      b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * ratePerSecond);
      b.last = t;
      if (b.tokens < n) {
        buckets.set(key, b);
        return false;
      }
      b.tokens -= n;
      buckets.set(key, b);
      return true;
    },
    clear(key) { buckets.delete(key); },
  };
}

/**
 * 定向提帧率（§5.3 修订）：页面在输入活跃窗口内返回提帧间隔，否则 null（host 用基础间隔）。
 * 只对输入路由命中的页生效（page.lastInputAt 在注入处置位）。
 */
export function frameIntervalFor(page, nowMs = Date.now()) {
  return nowMs - (page.lastInputAt ?? 0) < INPUT_BOOST_WINDOW_MS
    ? INPUT_FRAME_BOOST_INTERVAL_MS
    : null;
}

/**
 * 事件 → CDP 注入计划（纯映射，无副作用）：mouse 系走 Input.dispatchMouseEvent
 * （pressed/released/wheel 携带 modifiers，D10），keyDown/keyUp 走 rawKeyDown/keyUp，
 * char 走 dispatchKeyEvent type=char，insertText 走 Input.insertText。
 */
export function inputDispatchPlan(e) {
  if (e.type === 'mouseMoved' || e.type === 'mousePressed' || e.type === 'mouseReleased' || e.type === 'mouseWheel') {
    const params = { type: e.type, x: e.x, y: e.y };
    if (e.type === 'mousePressed' || e.type === 'mouseReleased') {
      params.button = e.button;
      params.clickCount = e.clickCount;
    }
    if (e.type === 'mouseWheel') {
      params.deltaX = e.deltaX;
      params.deltaY = e.deltaY;
    }
    if (e.modifiers != null) params.modifiers = e.modifiers;
    return { method: 'Input.dispatchMouseEvent', params };
  }
  if (e.type === 'keyDown' || e.type === 'keyUp') {
    const params = {
      type: e.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.windowsVirtualKeyCode,
    };
    if (e.modifiers != null) params.modifiers = e.modifiers;
    return { method: 'Input.dispatchKeyEvent', params };
  }
  if (e.type === 'char') {
    return { method: 'Input.dispatchKeyEvent', params: { type: 'char', text: e.text } };
  }
  return { method: 'Input.insertText', params: { text: e.text } };
}

/**
 * 组装 applyInput(data)（§5.2 注入流程）：
 * 1. 校验（§4 约束）→ 2. 路由（优先 targetId 全局命中，否则最近出帧页）→
 * 3. 每 cliSession 限速 → 4. 逐事件注入 CDP → 5. 置位 page.lastInputAt（定向提帧率）。
 *
 * deps：
 * - browsers：Map<cliSession, { pages: Map<targetId, { sessionId, ... }> }>（host 结构）
 * - getLastActiveFrame()：{ cliSession, targetId } | null（Page.screencastFrame 处维护）
 * - cdpCall(entry, method, params, sessionId)
 * - rateLimiter：createInputRateLimiter 实例（跨批持有）
 * - log：只允许计数级日志（D7 隐私纪律）
 * 返回注入的事件数（非法/限速/无路由返回 0）。
 */
export function createInputApplier({
  browsers,
  getLastActiveFrame,
  cdpCall,
  rateLimiter,
  log = () => {},
  now = Date.now,
} = {}) {
  return function applyInput(data) {
    const batch = validInputBatch(data);
    if (!batch) return 0;
    let cliSession = null;
    let page = null;
    if (batch.targetId) {
      for (const [cs, entry] of browsers) {
        const p = entry?.pages?.get?.(batch.targetId);
        if (p) { cliSession = cs; page = p; break; }
      }
    }
    if (!page) {
      const last = getLastActiveFrame?.() ?? null;
      if (last && browsers.has(last.cliSession)) {
        const p = browsers.get(last.cliSession)?.pages?.get(last.targetId);
        if (p) { cliSession = last.cliSession; page = p; }
      }
    }
    if (!page) return 0;
    if (rateLimiter && !rateLimiter.allow(String(cliSession), batch.events.length)) {
      log(`input rate-limited cliSession=${cliSession} events=${batch.events.length}`);
      return 0;
    }
    const entry = browsers.get(cliSession);
    for (const e of batch.events) {
      const plan = inputDispatchPlan(e);
      cdpCall(entry, plan.method, plan.params, page.sessionId);
    }
    page.lastInputAt = now();
    log(`input cliSession=${cliSession} target=${batch.targetId ?? 'auto'} events=${batch.events.length}`);
    return batch.events.length;
  };
}
