import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { LocalToolSessionRegistry, PendingLocalToolRequest } from './local-tool-session-registry.js';
import {
  createWindowedReadStream,
  WINDOWED_READ_CHUNK_BYTES,
  WINDOWED_READ_WINDOW_SIZE,
} from '../streaming/windowed-pull-stream.js';

/**
 * LOCAL 发送字节委托读取（技术方案 2026-11-18-unified-send-media §6；
 * 2026-11-25-send-file-1gb R2 改为服务端窗口拉取）。
 *
 * 旧协议是执行端一口气推 2048 片、服务端拼装成整块 Buffer——1GB 下服务端内存、
 * WS 反压和 V8 字符串上限都过不去。现在：
 *
 * - `delivery_read` 的 `open` 帧只做路径校验 + stat，回 `size` / `mtimeMs`；
 * - 服务端按 512KB × 8 片窗口发 `read` 帧，执行端按 offset 读、回一片；
 * - 结束 / 失败 / 取消发 `close` 帧，执行端关闭句柄（空闲 60 秒也会自动关）；
 * - 每片响应都带 size / mtimeMs，发送期间文件被改写即失败。
 *
 * 与 `LocalFileFetchService`（正文图片，10MB，不落盘）消息名与上限都分开。
 */
export const DELIVERY_READ_CHUNK_BYTES = WINDOWED_READ_CHUNK_BYTES;
export const DELIVERY_FETCH_MAX_CHUNKS = Math.ceil((1024 * 1024 * 1024) / DELIVERY_READ_CHUNK_BYTES);
/** 首帧（open）超时：旧执行端不认识新帧、静默不回包，10 秒内按「版本过旧」收敛（R2）。 */
export const DELIVERY_OPEN_TIMEOUT_MS = 10_000;
/** 单片读取超时：60 秒没有回片即失败（与执行端空闲回收同量级）。 */
export const DELIVERY_READ_TIMEOUT_MS = 60_000;
/**
 * 整份 sha256 超时：1GB 顺序读 + 哈希，单片 60 秒不够（机械盘 / 网络盘 / 有并发 IO 时必超）。
 * 覆盖一次 digest 往返，不是单片读取。
 */
export const DELIVERY_DIGEST_TIMEOUT_MS = 300_000;
/** per-user 在途流上限（每路内存是 8 片窗口 ≈ 4MB，而不是整份文件）。 */
export const DELIVERY_FETCH_MAX_INFLIGHT_PER_USER = 4;

const OFFLINE_ERROR = '执行端不在线或版本过旧，无法读取本机文件';
/** 在途上限命中：与「执行端不在线」区分开，否则用户会去重装客户端。 */
const INFLIGHT_LIMIT_ERROR = '当前有多个文件正在发送，请稍后重试';

export type DeliveryFetchOutcome =
  | {
    ok: true;
    stream: Readable;
    size: number;
    /** 执行端对整份文件的 sha256（R8）：写入完成后比对，不一致即失败。 */
    digest: () => Promise<string>;
    /** 释放执行端句柄（摘要比对后显式调用）。 */
    close: () => void;
  }
  | { ok: false; error: string };

/** `delivery_read_result` 入站帧的松散形状：字段合法性由 handleResult 逐项校验。 */
export interface DeliveryReadResultFrame {
  ok?: unknown;
  data?: unknown;
  size?: unknown;
  mtimeMs?: unknown;
  sha256?: unknown;
  error?: unknown;
}

interface OpenWaitEntry {
  /** 本次 open 对应的流：成功回包时据此把认领连接与 streamId 绑定。 */
  streamId: string;
  /**
   * 首个失败回包的错误文案：
   * - 定向投递（绑定设备）时立即失败，文案就是执行端的确定原因（如「文件过大」）；
   * - 用户级广播时继续等其它执行端的成功回包，超时后再用它收敛。
   */
  error: string | null;
  /** 定向投递的失败快速通道（首个 ok:false 直接 reject）。 */
  failFast: ((error: string) => void) | null;
}

interface StreamState {
  userId: number;
  /** 已关闭（正常结束 / 失败 / 取消）：避免 onClose 重复 release。 */
  closed: boolean;
}

export class LocalDeliveryFetchService {
  private readonly openWaits = new Map<string, OpenWaitEntry>();
  private readonly streams = new Map<string, StreamState>();
  /**
   * streamId → 认领该流的连接 id。
   *
   * 未绑定设备的会话走用户级广播：同一用户可能同时在线桌面端与 mao-agent（甚至两台机器）。
   * `open` 由首个成功的执行端认领，之后的 `read` / `digest` / `close` 必须定向到同一条连接——
   * 否则另一台没有该 streamId 的设备回的「读取流已关闭或不存在」会抢先结算整次发送
   * （2026-11-25 send_file 1GB R2 的多执行端回归）。
   */
  private readonly streamSockets = new Map<string, string>();
  private readonly activeByUser = new Map<number, number>();

  constructor(private readonly registry: LocalToolSessionRegistry) {}

  private countActiveForUser(userId: number): number {
    return this.activeByUser.get(userId) ?? 0;
  }

  private trackStream(userId: number, streamId: string): boolean {
    if (this.countActiveForUser(userId) >= DELIVERY_FETCH_MAX_INFLIGHT_PER_USER) return false;
    this.streams.set(streamId, { userId, closed: false });
    this.activeByUser.set(userId, this.countActiveForUser(userId) + 1);
    return true;
  }

  private releaseStream(streamId: string): void {
    const state = this.streams.get(streamId);
    if (state == null || state.closed) return;
    state.closed = true;
    this.streams.delete(streamId);
    const next = this.countActiveForUser(state.userId) - 1;
    if (next <= 0) this.activeByUser.delete(state.userId);
    else this.activeByUser.set(state.userId, next);
  }

  /**
   * 打开执行端本机文件字节流。失败一律以 `{ ok: false, error }` 返回，不抛异常。
   * 首帧 10 秒内没有成功回包：若期间收到过确定失败（如「文件过大」）用该文案，
   * 否则统一报「执行端不在线或版本过旧」——旧执行端不认识新帧，静默不回。
   */
  async openStream(
    sessionId: number,
    userId: number | null,
    filePath: string,
    workspace: string | null | undefined,
    maxBytes: number,
  ): Promise<DeliveryFetchOutcome> {
    const streamId = randomUUID();
    if (userId != null && !this.trackStream(userId, streamId)) {
      return { ok: false, error: INFLIGHT_LIMIT_ERROR };
    }
    let pending: PendingLocalToolRequest;
    try {
      pending = await this.registry.sendDeliveryReadRequest(sessionId, {
        action: 'open',
        streamId,
        path: filePath,
        workspace: workspace ?? '',
        maxBytes,
      });
    } catch (e) {
      // 目标解析 / 投递准备阶段抛错（如会话查库抖动）：释放刚登记的并发名额再往上抛
      this.releaseStream(streamId);
      throw e;
    }
    if (pending.requestId == null) {
      this.releaseStream(streamId);
      return { ok: false, error: await offlineErrorOf(pending.future) };
    }
    const requestId = pending.requestId;
    const wait: OpenWaitEntry = { streamId, error: null, failFast: null };
    this.openWaits.set(requestId, wait);
    let failFast: Promise<never> | null = null;
    if (pending.directed) {
      failFast = new Promise<never>((_, reject) => {
        wait.failFast = (error) => reject(new Error(error));
      });
    }
    let opened: { ok: true; size: number; mtimeMs: number } | { ok: false; error: string };
    try {
      const first = await raceTimeout(
        failFast == null ? pending.future : Promise.race([pending.future, failFast]),
        DELIVERY_OPEN_TIMEOUT_MS,
        () => {
          this.registry.dropToolRequest(sessionId, requestId);
          this.openWaits.delete(requestId);
        },
      );
      opened = parseOpenFrame(first);
    } catch {
      this.openWaits.delete(requestId);
      // 定向投递被 failFast 快速拒绝时也要摘掉 pending 表项，否则会滞留到断线/会话结束
      this.registry.dropToolRequest(sessionId, requestId);
      this.releaseStream(streamId);
      return { ok: false, error: wait.error ?? OFFLINE_ERROR };
    }
    this.openWaits.delete(requestId);
    this.releaseStream(streamId);
    if (!opened.ok) return { ok: false, error: opened.error };
    // mtimeMs 缺失会让后续每片都报「文件在发送期间被修改」，与真实原因无关，按不可用收敛
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || !Number.isFinite(opened.mtimeMs)) {
      this.closeStream(sessionId, streamId);
      return { ok: false, error: OFFLINE_ERROR };
    }
    if (opened.size > maxBytes) {
      // 执行端已经打开句柄：这里失败也必须发 close，否则 fd 要等到 60 秒空闲回收
      this.closeStream(sessionId, streamId);
      return { ok: false, error: `文件过大，上限 ${Math.floor(maxBytes / (1024 * 1024))}MB` };
    }
    if (userId != null && !this.trackStream(userId, streamId)) {
      this.closeStream(sessionId, streamId);
      return { ok: false, error: INFLIGHT_LIMIT_ERROR };
    }
    const size = opened.size;
    const mtimeMs = opened.mtimeMs;
    const stream = createWindowedReadStream({
      size,
      chunkBytes: DELIVERY_READ_CHUNK_BYTES,
      windowSize: WINDOWED_READ_WINDOW_SIZE,
      read: async (offset, length) => {
        const readPending = await this.sendFrame(sessionId, streamId, {
          action: 'read',
          streamId,
          offset,
          length,
        });
        if (readPending.requestId == null) throw new Error(await offlineErrorOf(readPending.future));
        const raw = await raceTimeout(
          readPending.future,
          DELIVERY_READ_TIMEOUT_MS,
          () => { this.registry.dropToolRequest(sessionId, readPending.requestId!); },
          '执行端读取超时，请重试',
        );
        const frame = parseResultFrame(raw);
        if (!frame.ok) throw new Error(frame.error);
        if (frame.size !== size || frame.mtimeMs !== mtimeMs) {
          throw new Error('文件在发送期间被修改，请重试');
        }
        return frame.data;
      },
      onClose: () => {
        this.closeStream(sessionId, streamId);
      },
    });
    const digest = async (): Promise<string> => {
      const digestPending = await this.sendFrame(sessionId, streamId, {
        action: 'digest',
        streamId,
      });
      if (digestPending.requestId == null) throw new Error(await offlineErrorOf(digestPending.future));
      const raw = await raceTimeout(
        digestPending.future,
        DELIVERY_DIGEST_TIMEOUT_MS,
        () => { this.registry.dropToolRequest(sessionId, digestPending.requestId!); },
        '执行端校验超时，请重试',
      );
      const frame = parseResultFrame(raw);
      if (!frame.ok) throw new Error(frame.error);
      if (frame.size !== size || frame.mtimeMs !== mtimeMs) {
        throw new Error('文件在发送期间被修改，请重试');
      }
      if (frame.sha256 === '') throw new Error('执行端未返回文件摘要，请重试');
      return frame.sha256;
    };
    return { ok: true, stream, size, digest, close: () => this.closeStream(sessionId, streamId) };
  }

  /**
   * 下发一帧 `delivery_read`：已锁定来源连接时只发给它（未绑定设备的广播会话在 open
   * 成功后锁定），否则走原有的定向 / 广播口径。
   */
  private sendFrame(
    sessionId: number,
    streamId: string,
    payload: { action: 'read' | 'digest'; streamId: string; offset?: number; length?: number },
  ): Promise<PendingLocalToolRequest> {
    const socketId = this.streamSockets.get(streamId) ?? null;
    if (socketId == null) return this.registry.sendDeliveryReadRequest(sessionId, payload);
    return this.registry.sendDeliveryReadRequest(sessionId, payload, { socketId });
  }

  /** 关闭执行端句柄并释放并发计数（正常结束由调用方在摘要比对后显式触发）。 */
  private closeStream(sessionId: number, streamId: string): void {
    const socketId = this.streamSockets.get(streamId) ?? null;
    this.streamSockets.delete(streamId);
    this.releaseStream(streamId);
    if (socketId == null) this.registry.sendDeliveryClose(sessionId, streamId);
    else this.registry.sendDeliveryClose(sessionId, streamId, socketId);
  }

  /**
   * `delivery_read_result` 入站处理（StreamingWsHandler 校验会话归属后调用）。
   * open 帧的失败回包只记录、不完成 future——用户级广播下多个执行端都可能响应，
   * 让正确设备的成功回包仍有机会获胜；超时后再用记录的错误收敛。
   * 成功回包携带的来源连接 id 会被记成这条流的归属：后续 read / digest / close 只发给它。
   */
  handleResult(sessionId: number, requestId: string, frame: DeliveryReadResultFrame, socketId?: string | null): void {
    const open = this.openWaits.get(requestId);
    if (open != null) {
      if (frame.ok === true) {
        if (typeof socketId === 'string' && socketId !== '') this.streamSockets.set(open.streamId, socketId);
        this.registry.completeToolRequest(sessionId, requestId, JSON.stringify(frame));
      } else if (typeof frame.error === 'string' && frame.error !== '') {
        if (open.error == null) open.error = frame.error;
        open.failFast?.(frame.error);
      }
      return;
    }
    this.registry.completeToolRequest(sessionId, requestId, JSON.stringify(frame));
  }
}

function parseOpenFrame(raw: string): { ok: true; size: number; mtimeMs: number } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; size?: unknown; mtimeMs?: unknown; error?: unknown };
    if (parsed.ok !== true) {
      return { ok: false, error: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : OFFLINE_ERROR };
    }
    return {
      ok: true,
      size: typeof parsed.size === 'number' ? parsed.size : Number.NaN,
      mtimeMs: typeof parsed.mtimeMs === 'number' ? parsed.mtimeMs : Number.NaN,
    };
  } catch {
    return { ok: false, error: OFFLINE_ERROR };
  }
}

function parseResultFrame(raw: string): {
  ok: true;
  data: Buffer;
  size: number;
  mtimeMs: number;
  sha256: string;
} | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: unknown; data?: unknown; size?: unknown; mtimeMs?: unknown; sha256?: unknown; error?: unknown;
    };
    if (parsed.ok !== true) {
      return { ok: false, error: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : OFFLINE_ERROR };
    }
    const data = typeof parsed.data === 'string' ? Buffer.from(parsed.data, 'base64') : Buffer.alloc(0);
    return {
      ok: true,
      data,
      size: typeof parsed.size === 'number' ? parsed.size : Number.NaN,
      mtimeMs: typeof parsed.mtimeMs === 'number' ? parsed.mtimeMs : Number.NaN,
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : '',
    };
  } catch {
    return { ok: false, error: OFFLINE_ERROR };
  }
}

function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
  timeoutMessage = 'timeout',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(timeoutMessage));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function offlineErrorOf(future: Promise<string>): Promise<string> {
  try {
    const parsed = JSON.parse(await future) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
  } catch { /* fall through */ }
  return OFFLINE_ERROR;
}
