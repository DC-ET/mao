/**
 * browser-live-recorder —— 浏览器直播回放录制器（技术方案 2026-11-22 §3，独立模块）。
 *
 * 唯一写入点在 sidecar 采集侧：host 在 emitFrame/emitStopped 处同步调用本模块，
 * 把每场直播的帧序列节流落盘到 <liveDir>/replay/<liveId>/（liveDir 即 .mao-browser）。
 * CLOUD / LOCAL 共用同一份脚本，录制逻辑写一次两端生效。
 *
 * 目录布局（§3.2）：
 *   replay/<liveId>/manifest.json   场摘要（started 时写初始版，之后逐帧原子刷新，
 *                                   stopped/截断/写失败时结算；崩溃未结算的场
 *                                   endedAt 保持 null，读取端以 timeline 兜底）
 *   replay/<liveId>/timeline.ndjson 帧索引（逐行 append，崩溃最多丢尾部半行）
 *   replay/<liveId>/f<seq>.jpg      原始 JPEG（与直播帧同一编码，不再二次压缩）
 *
 * 设计约束：
 * - 零依赖、可被 node:test 直载（host 脚本 import 即有副作用，不可直载——录制器必须独立成文件）。
 * - 录制故障绝不影响直播：所有入口吞错，写失败仅回调 log 并停录本场。
 * - 场边界容错：emitStopped 可在零帧/未 started 时触发（no-op）；
 *   CLOUD WS 重连成功会复位 host 闩锁并补发 started——onStarted 在有进行中场时
 *   先结算旧场再开新目录（长直播一次瞬断重连把场一分为二，与直播前端语义一致）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MANIFEST_VERSION = 1;
/** manifest 原子写临时后缀 */
const TMP_SUFFIX = `.tmp`;

/**
 * @param {{
 *   liveDir: string,            // <runtimeDir>/.mao-browser（replay/ 建在其下）
 *   sessionId: string,          // sidecar 的 MAO_SESSION_ID（manifest 归属字段）
 *   enabled?: boolean,          // host 读 env 后传入；false 时所有入口为 no-op
 *   maxBytes?: number,          // 单场累计 bytes 上限（默认 300MB），超限截断停录
 *   minIntervalMs?: number,     // 录制节流（默认 1000ms，全局口径跨页共享）：距上一录帧
 *                               // <minIntervalMs 的帧只直播不落盘
 *   maxUrls?: number,           // manifest.urls 去重上限（防超长刷屏）
 *   log?: (...parts: unknown[]) => void,
 *   now?: () => number,         // 可注入时钟（测试用）
 * }} opts
 */
export function createRecorder({
  liveDir,
  sessionId,
  enabled = true,
  maxBytes = 300 * 1024 * 1024,
  minIntervalMs = 1000,
  maxUrls = 50,
  log = () => {},
  now = () => Date.now(),
}) {
  /** 进行中场：{ dir, liveId, startedAt, lastRecTs, frameCount, approxBytes, urls, cliSessions, truncated } */
  let active = null;
  let disabled = !enabled;

  const replayRoot = path.join(liveDir, 'replay');

  function safeLog(...parts) {
    try { log('[recorder]', ...parts); } catch { /* 日志失败不影响采集 */ }
  }

  /** manifest 原子写（tmp + rename），失败仅记日志——读取端对缺 manifest 容忍。 */
  function writeManifest(dir, manifest) {
    const file = path.join(dir, 'manifest.json');
    const tmp = `${file}.${process.pid}${TMP_SUFFIX}`;
    writeFileSync(tmp, JSON.stringify(manifest));
    try {
      renameSync(tmp, file);
    } catch {
      try { rmSync(file, { force: true }); renameSync(tmp, file); } catch { /* 下一帧重试 */ }
    }
  }

  function manifestSnapshot(state) {
    return {
      version: MANIFEST_VERSION,
      liveId: state.liveId,
      sessionId,
      startedAt: state.startedAt,
      endedAt: state.endedAt ?? null,
      frameCount: state.frameCount,
      durationMs: state.endedAt != null ? state.endedAt - state.startedAt : null,
      approxBytes: state.approxBytes,
      cliSessions: [...state.cliSessions],
      urls: [...state.urls],
      truncated: state.truncated,
    };
  }

  /** 结算本场：零帧场直接删目录（无内容可回放，避免列表出现空场）；否则原子写 manifest。 */
  function finalize(state, { endedAt = null, truncated = state.truncated } = {}) {
    try {
      if (state.frameCount === 0) {
        rmSync(state.dir, { recursive: true, force: true });
        return;
      }
      writeManifest(state.dir, manifestSnapshot({ ...state, endedAt, truncated }));
    } catch (e) {
      safeLog('finalize failed', (e?.message ?? String(e)));
    }
  }

  /** liveId = L<startedAt 毫秒>；同毫秒碰撞（理论边界）顺延，目录已存在则再顺延。 */
  function allocateLiveDir(startedAt) {
    let candidate = startedAt;
    for (let i = 0; i < 1000; i += 1) {
      const dir = path.join(replayRoot, `L${candidate}`);
      if (!existsSync(dir)) return { dir, liveId: `L${candidate}`, ts: candidate };
      candidate += 1;
    }
    return null;
  }

  return {
    /** host emitFrame 首帧（started 闩锁翻转处）调用。已有进行中场时先结算旧场（WS 重连拆场）。 */
    onStarted({ ts } = {}) {
      if (disabled) return;
      try {
        if (active) {
          safeLog('started while active, settling previous session', active.liveId);
          finalize(active, { endedAt: active.lastRecTs || active.startedAt });
          active = null;
        }
        const slot = allocateLiveDir(ts ?? now());
        if (!slot) {
          safeLog('no free liveId slot, recording disabled for this session');
          disabled = true;
          return;
        }
        mkdirSync(slot.dir, { recursive: true });
        active = {
          dir: slot.dir,
          liveId: slot.liveId,
          startedAt: slot.ts,
          endedAt: null,
          lastRecTs: 0,
          frameCount: 0,
          approxBytes: 0,
          urls: new Set(),
          cliSessions: new Set(),
          truncated: false,
        };
        writeManifest(active.dir, manifestSnapshot(active));
        safeLog(`recording session dir=${path.join('replay', active.liveId)}`);
      } catch (e) {
        // 目录不可写等初始化失败：本场不录（active 置空），帧照常直播
        safeLog('onStarted failed, skip this session', (e?.message ?? String(e)));
        active = null;
      }
    },

    /**
     * host emitFrame 每帧调用（frame 与直播 emit 的 data 同构：seq/ts/jpeg(base64)/width/height/pageUrl/cliSession）。
     * 节流 / 超限的帧只直播不落盘；写失败停录本场（truncated 结算），绝不抛出。
     */
    onFrame(frame) {
      if (disabled || !active || !frame) return;
      const { seq, ts, jpeg, pageUrl, cliSession } = frame;
      try {
        if (active.lastRecTs > 0 && ts - active.lastRecTs < minIntervalMs) return;
        const buf = Buffer.from(String(jpeg ?? ''), 'base64');
        if (buf.length === 0) return;
        if (active.approxBytes > 0 && active.approxBytes + buf.length > maxBytes) {
          safeLog(`size cap reached (${active.approxBytes} bytes), truncate session ${active.liveId}`);
          active.truncated = true;
          finalize(active, { endedAt: active.lastRecTs || ts });
          active = null;
          return;
        }
        const file = `f${seq}.jpg`;
        writeFileSync(path.join(active.dir, file), buf);
        appendFileSync(path.join(active.dir, 'timeline.ndjson'),
          `${JSON.stringify({ seq, ts, pageUrl: pageUrl ?? '', width: frame.width ?? 0, height: frame.height ?? 0, bytes: buf.length, file })}\n`);
        if (pageUrl && active.urls.size < maxUrls) active.urls.add(pageUrl);
        if (cliSession) active.cliSessions.add(cliSession);
        active.frameCount += 1;
        active.approxBytes += buf.length;
        active.lastRecTs = ts;
        // manifest 逐帧原子刷新：崩溃未结算的场也有实时 frameCount/urls 可读
        writeManifest(active.dir, manifestSnapshot(active));
      } catch (e) {
        safeLog(`frame write failed, stop recording session ${active.liveId}`, (e?.message ?? String(e)));
        finalize(active, { endedAt: active.lastRecTs || ts || now(), truncated: true });
        active = null;
      }
    },

    /** host emitStopped 调用；零帧/未 started 的 stopped 是合法路径，直接 no-op。 */
    onStopped() {
      if (disabled || !active) return;
      const state = active;
      active = null;
      finalize(state, { endedAt: state.lastRecTs || now() });
      safeLog(`session settled liveId=${state.liveId} frames=${state.frameCount} bytes=${state.approxBytes}`);
    },
  };
}
