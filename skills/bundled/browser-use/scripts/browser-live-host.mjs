#!/usr/bin/env node
/**
 * browser-live-host —— browser-use 技能的直播采集 sidecar（零 npm 依赖，需 Node >= 22）。
 *
 * 职责（技术方案 docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md v2 D2/D3）：
 * 1. 监视 <live-dir>/cdp/<cliSession>.port，旁路接入 playwright-cli daemon 拉起的浏览器 CDP 端口；
 * 2. 对每个页面 Target.setAutoAttach + Page.startScreencast 采帧（JPEG，逐帧 ack，按页限速）；
 * 3. 帧出口：
 *    - local：本机 HTTP/SSE server（Electron 主进程消费，POST /stop 停止）；
 *    - cloud：WS client 连后端 /api/ws/stream（runner_auth 握手，browser_live_stop 下行）。
 *
 * 生命周期：CDP 连续判死 / 收到 stop / 2h 硬上限 → 清理退出；stop 会先 Browser.close 杀浏览器。
 * 本进程由 wrapper 经 node spawn(detached:true) 拉起——自成进程组，逃逸 shell 工具的整组 SIGKILL。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRecorder } from './browser-live-recorder.mjs';

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else { out[a.slice(2)] = argv[i + 1]; i++; }
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const LIVE_DIR = path.resolve(args['live-dir'] ?? '.');
const MODE = args.mode === 'cloud' ? 'cloud' : 'local';
const MAO_SESSION_ID = String(args.session ?? '');
const CDP_DIR = path.join(LIVE_DIR, 'cdp');
const HOST_PID = path.join(LIVE_DIR, 'host.pid');
const HOST_READY = path.join(LIVE_DIR, 'host.ready');
const LIVE_JSON = path.join(LIVE_DIR, 'live.json');

const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;   // 硬上限：2h 自杀
const CONNECT_WAIT_MS = 10 * 60 * 1000;       // 从未连上任何 CDP 端口的最长等待
const DEAD_PROBES = 3;                        // CDP 连续判死探测次数（1s 间隔）
const PAGE_MIN_INTERVAL_MS = 250;             // 按页限速 ≈4fps
const MAX_FRAME_B64 = 683_000;                // ≈512KB 二进制，超限丢弃（仍 ack）

for (const d of [LIVE_DIR, CDP_DIR, path.join(LIVE_DIR, 'logs')]) mkdirSync(d, { recursive: true });

function log(...parts) {
  try {
    appendFileSync(path.join(LIVE_DIR, 'logs', 'host.log'),
      `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch { /* 日志失败不影响采集 */ }
}
function writeJson(file, obj, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), { mode });
  try {
    renameSync(tmp, file);
  } catch {
    try { rmSync(file, { force: true }); renameSync(tmp, file); } catch { /* 写失败下次重试 */ }
  }
}

// ---------- 退出清理 ----------
let exitTimer = null;
function exitSoon(delayMs, reason) {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    log('exit', reason);
    cleanupFiles();
    process.exit(0);
  }, delayMs);
  exitTimer.unref?.();
}
function cancelExit() {
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
}
function cleanupFiles() {
  // 归属检查：host.pid 已易主（新实例接管同一运行时目录）时不碰共享文件——
  // 旧实例的延迟退出清理（SIGTERM 后 300ms）会删掉新实例刚写的 live.json
  try {
    const raw = readFileSync(HOST_PID, 'utf8').trim();
    if (raw && Number(raw) !== process.pid) return;
  } catch { /* pid 文件已不在：按无主处理，继续清理 */ }
  // 只清自己的身份文件；cdp/*.port 故意保留——sidecar 超时/异常退出后浏览器可能还活着，
  // wrapper 下一条命令探测端口成功即可复用同一端口重启 sidecar 无缝续播（崩溃恢复路径）
  for (const f of [HOST_PID, HOST_READY, LIVE_JSON]) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
}
const exitNow = (reason) => { emitStopped(reason); exitSoon(300, reason); };

process.on('SIGTERM', () => { log('SIGTERM'); exitNow('session_end'); });
process.on('SIGINT', () => { log('SIGINT'); exitNow('session_end'); });

// ---------- 双宿竞争：spawner（wrapper 的 node -e）已写入 host.pid；发现他人存活则退出 ----------
setTimeout(() => {
  try {
    const raw = readFileSync(HOST_PID, 'utf8').trim();
    const pid = Number(raw);
    if (raw && pid !== process.pid) {
      try { process.kill(pid, 0); log('another host alive pid=', pid, '-> exit'); process.exit(0); } catch { /* 已死，接管 */ }
    }
  } catch { /* 无 pid 文件，接管 */ }
  writeFileSync(HOST_PID, String(process.pid));
  writeFileSync(HOST_READY, new Date().toISOString());
  log(`host started mode=${MODE} liveDir=${LIVE_DIR} session=${MAO_SESSION_ID} pid=${process.pid} node=${process.version}`);
}, 150).unref?.();

// ---------- CDP 接入 ----------
/** cliSession -> { port, ws, alive, pages: Map<targetId, {sessionId, url, lastSent, castOn}>, deadTicks } */
const browsers = new Map();
let connectEver = false;
let seq = 0;
let startedEmitted = false;

function cdpCall(entry, method, params, sessionId) {
  const id = entry.nextId++;
  const frame = sessionId ? { id, method, params, sessionId } : { id, method, params };
  try { entry.ws.send(JSON.stringify(frame)); } catch { /* 连接死亡由 onclose 处理 */ }
}

async function probeCdp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function connectBrowser(cliSession, port) {
  if (browsers.has(cliSession)) return;
  cancelExit(); // 浏览器重新可用（崩溃恢复 / 重开）：撤销挂起的自杀定时器
  const entry = { port, ws: null, alive: false, pages: new Map(), deadTicks: 0, stopping: false, nextId: 1 };
  browsers.set(cliSession, entry);
  void (async () => {
    const ver = await probeCdp(port);
    if (!ver?.webSocketDebuggerUrl || !browsers.has(cliSession)) {
      browsers.delete(cliSession);
      return;
    }
    connectEver = true;
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    entry.ws = ws;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) log(`cdp error ${msg.error.message ?? JSON.stringify(msg.error)}`);
        resolve(msg.result ?? null);
        return;
      }
      handleCdpEvent(cliSession, msg);
    };
    ws.onopen = () => {
      entry.alive = true;
      entry.deadTicks = 0;
      log(`cdp connected cliSession=${cliSession} port=${port}`);
      // 浏览器级自动 attach：当前与未来的 page target 全部接管（CLI 新开 tab 无需重扫）
      cdpCall(entry, 'Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      });
      onConsumerCountChanged();
    };
    ws.onclose = () => {
      entry.alive = false;
      log(`cdp closed cliSession=${cliSession}`);
      scheduleDeadProbe(cliSession);
    };
    ws.onerror = () => { /* onclose 会跟进 */ };
  })();
}

function handleCdpEvent(cliSession, msg) {
  const entry = browsers.get(cliSession);
  if (!entry) return;
  if (msg.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = msg.params ?? {};
    if (targetInfo?.type !== 'page') return; // 只采页面（过滤 service_worker / browser 等）
    entry.pages.set(targetInfo.targetId, { sessionId, url: targetInfo.url ?? '', lastSent: 0, castOn: false });
    syncScreencast(entry, targetInfo.targetId);
  } else if (msg.method === 'Target.targetInfoChanged') {
    const info = msg.params?.targetInfo;
    if (info?.type === 'page' && entry.pages.has(info.targetId)) entry.pages.get(info.targetId).url = info.url ?? '';
  } else if (msg.method === 'Target.detachedFromTarget') {
    const targetId = [...entry.pages.entries()].find(([, p]) => p.sessionId === msg.params?.sessionId)?.[0];
    if (targetId) entry.pages.delete(targetId);
  } else if (msg.method === 'Page.screencastFrame') {
    const p = msg.params ?? {};
    // 注意两个 id 不同：msg.sessionId 是页面的扁平化 CDP 会话；p.sessionId 是 screencast
    // 采集会话 id（ack 的 params 用后者，命令信封用前者）。必须逐帧 ack，否则 CDP 不再
    // 出帧（POC P2）；被限速丢弃的帧也要 ack。
    const flatSid = msg.sessionId;
    cdpCall(entry, 'Page.screencastFrameAck', { sessionId: p.sessionId }, flatSid);
    const meta = [...entry.pages.entries()].find(([, pg]) => pg.sessionId === flatSid);
    const now = Date.now();
    if (!meta || p.data == null || p.data.length > MAX_FRAME_B64) return;
    if (now - meta[1].lastSent < PAGE_MIN_INTERVAL_MS) return;
    meta[1].lastSent = now;
    emitFrame(cliSession, meta[1].url, p.data, Number(p.metadata?.width ?? 0), Number(p.metadata?.height ?? 0));
  }
}

/** 端口文件出现/变更 → 重连；文件消失 → 认为浏览器已死（close 语义），直接判死清理 */
let portWatcher = null;
function scanPortFiles() {
  let names = [];
  try { names = readdirSync(CDP_DIR).filter((n) => n.endsWith('.port')); } catch { /* 目录缺失 */ }
  const seen = new Set();
  for (const name of names) {
    const cliSession = name.slice(0, -5);
    seen.add(cliSession);
    if (browsers.has(cliSession)) continue;
    try {
      const port = Number(readFileSync(path.join(CDP_DIR, name), 'utf8').trim());
      if (Number.isInteger(port) && port > 0) connectBrowser(cliSession, port);
    } catch { /* 读失败下次再扫 */ }
  }
  // 端口文件被删（wrapper 判死重挑端口 / 会话清理）：断开对应接入
  for (const cliSession of [...browsers.keys()]) {
    if (!seen.has(cliSession)) killBrowserEntry(cliSession, 'browser_exit');
  }
}
function startPortWatcher() {
  scanPortFiles();
  try {
    portWatcher = watch(CDP_DIR, { persistent: false }, () => scanPortFiles());
  } catch { /* fs.watch 不可用时依赖轮询 */ }
  const poll = setInterval(scanPortFiles, 2000);
  poll.unref?.();
}

function killBrowserEntry(cliSession, reason) {
  const entry = browsers.get(cliSession);
  if (!entry) return;
  browsers.delete(cliSession);
  try { entry.ws?.close(); } catch { /* ignore */ }
  try { rmSync(path.join(CDP_DIR, `${cliSession}.port`), { force: true }); } catch { /* ignore */ }
  if (reason) emitStopped(reason, cliSession);
  if (browsers.size === 0) exitSoon(2000, 'no_live_browser');
}

/** CDP onclose 后连续探测：浏览器退出（close/kill）与瞬时断连区分开 */
function scheduleDeadProbe(cliSession) {
  const tick = async () => {
    const entry = browsers.get(cliSession);
    if (!entry) return;
    if (entry.alive || entry.stopping) return;
    const ver = await probeCdp(entry.port);
    if (ver) { connectBrowserRetry(cliSession, entry.port); return; }
    entry.deadTicks += 1;
    if (entry.deadTicks >= DEAD_PROBES) killBrowserEntry(cliSession, 'browser_exit');
    else setTimeout(tick, 1000).unref?.();
  };
  setTimeout(tick, 1000).unref?.();
}
function connectBrowserRetry(cliSession, port) {
  // 端口仍在但连接断了（瞬时）：重建接入
  browsers.delete(cliSession);
  connectBrowser(cliSession, port);
}

// ---------- 采集开关：有消费者才推帧 ----------
let consumers = 0;
function onConsumerCountChanged() {
  for (const [cliSession, entry] of browsers) {
    if (!entry.alive) continue;
    for (const targetId of entry.pages.keys()) syncScreencast(entry, targetId);
    log(`consumer=${consumers} cliSession=${cliSession} pages=${entry.pages.size}`);
  }
}
function syncScreencast(entry, targetId) {
  const page = entry.pages.get(targetId);
  if (!page) return;
  const want = consumers > 0;
  if (want && !page.castOn) {
    page.castOn = true;
    cdpCall(entry, 'Page.startScreencast',
      { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720 }, page.sessionId);
  } else if (!want && page.castOn) {
    page.castOn = false;
    cdpCall(entry, 'Page.stopScreencast', {}, page.sessionId);
  }
}
function addConsumer() {
  consumers += 1;
  onConsumerCountChanged();
}
function removeConsumer() {
  consumers = Math.max(0, consumers - 1);
  onConsumerCountChanged();
}

// ---------- 回放录制（技术方案 2026-11-22 §3）：开关经 env 注入，未注入 = 不录 ----------
// 录制 tee 在 emitFrame/emitStopped 处同步调用；开启时自持一个 consumer 槽，
// 零观众时画面照采（§3.3）。单场上限 env 可调，超限截断停录本场、直播不受影响。
const RECORDER_ENABLED = process.env.MAO_BROWSER_LIVE_RECORD === '1';
const RECORD_MAX_MB_RAW = Number(process.env.MAO_BROWSER_LIVE_RECORD_MAX_MB ?? 300);
const recorder = RECORDER_ENABLED
  ? createRecorder({
      liveDir: LIVE_DIR,
      sessionId: MAO_SESSION_ID,
      enabled: true,
      // env 非法（非数字/<=0）回退默认 300，避免 NaN 让单场上限闸门静默失效
      maxBytes: (Number.isFinite(RECORD_MAX_MB_RAW) && RECORD_MAX_MB_RAW > 0 ? RECORD_MAX_MB_RAW : 300) * 1024 * 1024,
      log,
    })
  : null;
if (recorder) {
  addConsumer();
  log('browser-live recorder enabled');
}

// ---------- 事件出口 ----------
function emitFrame(cliSession, pageUrl, jpeg, width, height) {
  const data = { seq: ++seq, ts: Date.now(), jpeg, width, height, pageUrl, cliSession };
  if (!startedEmitted) {
    startedEmitted = true;
    recorder?.onStarted({ ts: data.ts });
    emit({ type: 'browser_live_started', data: { width, height, pageUrl, cliSession } });
  }
  // 录制 tee 在直播出口之前：录制节流/超限只影响落盘，不影响 emit（§3.4）
  recorder?.onFrame(data);
  emit({ type: 'browser_frame', data });
}
function emitStopped(reason, cliSession) {
  // host 进程会被 wrapper 复用（cancelExit 撤销自毁窗），不复位闩锁的话
  // 下一场直播只发帧不发 started，前端 isLive 无法重新置真（永远显示已结束）
  recorder?.onStopped(reason);
  startedEmitted = false;
  emit({ type: 'browser_live_stopped', data: { reason, ...(cliSession ? { cliSession } : {}) } });
}
function emit(evt) {
  for (const sink of sinks) sink(evt);
}

// ---------- 出口一：LOCAL SSE server ----------
const sinks = new Set();
function startLocalServer() {
  const token = randomBytes(16).toString('hex');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      res.writeHead(200).end();
      doStop('user_stop');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/live') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(':live\n\n');
      const client = (evt) => {
        try { res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data ?? {})}\n\n`); } catch { /* ignore */ }
      };
      sinks.add(client);
      addConsumer();
      // close 只登记一次（req 与 res 的 close 在同一连接上会先后触发）
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        sinks.delete(client);
        removeConsumer();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }
    res.writeHead(404).end();
  });
  // 仅绑回环
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    writeJson(LIVE_JSON, { httpPort: port, token, pid: process.pid, mode: 'local' }, 0o600);
    log(`sse server on 127.0.0.1:${port}`);
  });
}

// ---------- 出口二：CLOUD WS client（/api/ws/stream + runner_auth） ----------
function startCloudClient() {
  const base = (process.env.MAO_BASE_URL ?? '').replace(/\/+$/, '');
  const token = process.env.MAO_TOKEN ?? '';
  if (!base || !token || !MAO_SESSION_ID) {
    log('cloud mode missing MAO_BASE_URL/MAO_TOKEN/session -> exit');
    exitSoon(100, 'config_missing');
    return;
  }
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/ws/stream`;
  let attempts = 0;
  const connect = () => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) {
      log('ws create failed', e?.message);
      exitSoon(300, 'runner_exit');
      return;
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'runner_auth', token, sessionId: Number(MAO_SESSION_ID) }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'connected' && msg.data?.runner === true) {
        attempts = 0;
        // 瞬断重连：后端断开超 5s 会合成 runner_exit、前端已置「已结束」，
        // 复位闩锁让下一帧补发 started，直播状态才能恢复
        startedEmitted = false;
        sinks.add((evt) => { try { ws.send(JSON.stringify(evt)); } catch { /* ignore */ } });
        addConsumer();
        log('runner connected to backend');
      } else if (msg.type === 'browser_live_stop') {
        doStop(String(msg.data?.reason ?? 'user_stop'));
      } else if (msg.type === 'error') {
        log('backend error frame', JSON.stringify(msg.data ?? {}));
        exitSoon(300, 'runner_exit');
      }
    };
    ws.onclose = () => {
      sinks.clear();
      attempts += 1;
      if (attempts <= 3) {
        log(`runner ws closed, retry ${attempts}/3`);
        setTimeout(connect, 2000).unref?.();
      } else {
        exitSoon(300, 'runner_exit');
      }
    };
  };
  connect();
}

// ---------- 停止：Browser.close 杀掉 CLI 拉起的浏览器 ----------
function doStop(reason) {
  log('stop requested reason=', reason);
  for (const entry of browsers.values()) {
    entry.stopping = true;
    try { entry.ws?.send(JSON.stringify({ id: 999_000, method: 'Browser.close', params: {} })); } catch { /* ignore */ }
  }
  // 浏览器退出有 1~2s 延迟（POC P5）；到点即广播 stopped 并退出，不等判死流程。
  // 此路径浏览器确定被杀，端口文件一并清掉（区别于超时/异常退出——那边保留文件供崩溃恢复）
  setTimeout(() => {
    emitStopped(reason);
    // 归属检查同 cleanupFiles：host.pid 易主说明新实例已接管，共享文件不归我删
    let ownsFiles = true;
    try {
      const raw = readFileSync(HOST_PID, 'utf8').trim();
      if (raw && Number(raw) !== process.pid) ownsFiles = false;
    } catch { /* 无 pid 文件，视为仍归我 */ }
    if (ownsFiles) {
      for (const cliSession of [...browsers.keys()]) {
        try { rmSync(path.join(CDP_DIR, `${cliSession}.port`), { force: true }); } catch { /* ignore */ }
      }
    }
    exitSoon(500, `stop_${reason}`);
  }, 1800).unref?.();
}

// ---------- 启动 ----------
if (MODE === 'local') startLocalServer();
else startCloudClient();
startPortWatcher();
setTimeout(() => exitSoon(0, 'timeout_2h'), MAX_LIFETIME_MS).unref?.();
setTimeout(() => {
  if (!connectEver) exitSoon(0, 'no_cdp_ever');
}, CONNECT_WAIT_MS).unref?.();
