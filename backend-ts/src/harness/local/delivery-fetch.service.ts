import { Buffer } from 'node:buffer';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

/**
 * LOCAL 发送字节委托读取（技术方案 2026-11-18-unified-send-media §6）：
 * `send_image` / `send_file` 在 LOCAL 会话读不到本机文件时，向绑定执行端下发
 * `delivery_fetch`，执行端经 `delivery_fetch_result` 分片回传，这里拼装后一次性
 * `completeToolRequest` 回填 registry future。与 `LocalFileFetchService`（正文图片，
 * 不落盘）消息名与上限都分开：本服务的字节直接成为会话副本并推送到通道。
 */

/** 分片上限（原始字节/片）：与 LocalFileFetchService 同表，base64 后 ≈683KB，序列化整帧 < 1MB maxPayload。 */
export const DELIVERY_FETCH_CHUNK_BYTES = 512 * 1024;
/** 单片 base64 长度上限（512KB → 699,052 字符），超出静默丢弃。 */
export const DELIVERY_FETCH_CHUNK_BASE64_MAX = 900_000;
/** 总超时：30MB / 512KB = 60 片，比 file_fetch 的 15 秒宽松（§6.2）。 */
export const DELIVERY_FETCH_TIMEOUT_SECONDS = 20;
/** per-user 在途软上限：兜拼装缓冲内存上界（60 片 × 512KB ≈ 30MB/请求）。 */
export const DELIVERY_FETCH_MAX_INFLIGHT_PER_USER = 4;
/** 惰性 TTL 清扫阈值：条目正常由 fetch() finally 必删，这里只兜异常路径。 */
const FETCH_ENTRY_TTL_MS = 30_000;

export type DeliveryFetchOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

/** `delivery_fetch_result` 入站帧的松散形状：字段合法性由 handleChunk 逐项校验，不合法静默丢弃。 */
export interface DeliveryFetchChunkFrame {
  seq?: unknown;
  total?: unknown;
  data?: unknown;
}

interface PendingDeliveryEntry {
  sessionId: number;
  userId: number;
  maxBytes: number;
  chunks: (Buffer | undefined)[];
  total: number | null;
  received: number;
  createdAt: number;
  /** 首片来源连接：未绑定会话用户级广播下多执行端都可能响应，锁定单来源防交织（file_fetch 同款）。 */
  sourceSocketId: string | null;
}

export class LocalDeliveryFetchService {
  private readonly pending = new Map<string, PendingDeliveryEntry>();

  constructor(private readonly registry: LocalToolSessionRegistry) {}

  private maxChunksFor(maxBytes: number): number {
    return Math.max(1, Math.ceil(maxBytes / DELIVERY_FETCH_CHUNK_BYTES));
  }

  private countInFlightForUser(userId: number): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.userId === userId) count += 1;
    }
    return count;
  }

  /** 拉取执行端本机文件字节。失败一律以 `{ ok: false, error }` 返回，不抛异常（调用方转 errorJson）。 */
  async fetch(
    sessionId: number,
    userId: number | null,
    filePath: string,
    workspace: string | null | undefined,
    maxBytes: number,
  ): Promise<DeliveryFetchOutcome> {
    this.sweepExpired();
    if (userId != null && this.countInFlightForUser(userId) >= DELIVERY_FETCH_MAX_INFLIGHT_PER_USER) {
      return { ok: false, error: '执行端不在线或版本过旧，无法读取本机文件' };
    }
    const pending = await this.registry.sendDeliveryRequest(sessionId, filePath, workspace ?? null, maxBytes);
    if (pending.requestId == null) {
      // 离线 / 投递落空：registry 已立即 resolve 错误 future
      return { ok: false, error: await offlineErrorOf(pending.future) };
    }
    const entry: PendingDeliveryEntry = {
      sessionId,
      userId: userId ?? 0,
      maxBytes,
      chunks: [],
      total: null,
      received: 0,
      createdAt: Date.now(),
      sourceSocketId: null,
    };
    this.pending.set(pending.requestId, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finalJson = await Promise.race([
        pending.future,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), DELIVERY_FETCH_TIMEOUT_SECONDS * 1000);
        }),
      ]);
      const parsed = JSON.parse(finalJson) as { base64?: string; error?: string };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        return { ok: false, error: parsed.error };
      }
      const bytes = typeof parsed.base64 === 'string' && parsed.base64.length > 0
        ? Buffer.from(parsed.base64, 'base64')
        : Buffer.alloc(0);
      if (bytes.length === 0) return { ok: false, error: '执行端不在线或版本过旧，无法读取本机文件' };
      if (bytes.length > maxBytes) return { ok: false, error: sizeError(maxBytes) };
      return { ok: true, bytes };
    } catch (e) {
      const error = e instanceof Error && e.message === 'timeout'
        ? '执行端不在线或版本过旧，无法读取本机文件'
        : '执行端不在线或版本过旧，无法读取本机文件';
      this.pending.delete(pending.requestId);
      this.registry.completeToolRequestError(sessionId, pending.requestId, error);
      return { ok: false, error };
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(pending.requestId);
    }
  }

  /**
   * `delivery_fetch_result` 入站处理（StreamingWsHandler 校验会话归属后调用）。
   * 自持 active Map 判定活跃：未命中静默丢弃。首片锁定来源连接，异源分片静默丢弃；
   * 失败不回错误帧（执行端协议口径），服务端靠超时收口。
   */
  handleChunk(sessionId: number, requestId: string, frame: DeliveryFetchChunkFrame, socketId?: string | null): void {
    const entry = this.pending.get(requestId);
    if (entry == null || entry.sessionId !== sessionId) return;
    if (entry.sourceSocketId == null) entry.sourceSocketId = socketId ?? null;
    else if (socketId != null && entry.sourceSocketId !== socketId) return;
    const total = typeof frame.total === 'number' && Number.isInteger(frame.total) ? frame.total : 0;
    const seq = typeof frame.seq === 'number' && Number.isInteger(frame.seq) ? frame.seq : 0;
    const data = typeof frame.data === 'string' ? frame.data : '';
    const maxChunks = this.maxChunksFor(entry.maxBytes);
    if (total < 1 || total > maxChunks || seq < 1 || seq > total) return;
    if (entry.total == null) {
      entry.total = total;
      entry.chunks = new Array(total);
    } else if (entry.total !== total) return;
    if (entry.chunks[seq - 1] != null) return; // 重复片
    let chunk: Buffer;
    try {
      chunk = Buffer.from(data, 'base64');
    } catch {
      return;
    }
    if (chunk.length === 0 || chunk.length > DELIVERY_FETCH_CHUNK_BYTES) return;
    if (data.length > DELIVERY_FETCH_CHUNK_BASE64_MAX) return;
    entry.chunks[seq - 1] = chunk;
    entry.received += 1;
    if (entry.received < entry.total) return;
    // 拼装完成：一次性回填 registry future
    this.pending.delete(requestId);
    const bytes = Buffer.concat(entry.chunks as Buffer[]);
    if (bytes.length > entry.maxBytes) {
      this.registry.completeToolRequestError(sessionId, requestId, sizeError(entry.maxBytes));
      return;
    }
    this.registry.completeToolRequest(sessionId, requestId, JSON.stringify({ base64: bytes.toString('base64') }));
  }

  /** 惰性 TTL 清扫：兜 fetch 已返回但缓冲仍残留的异常路径。 */
  private sweepExpired(now = Date.now()): void {
    for (const [requestId, entry] of this.pending) {
      if (now - entry.createdAt > FETCH_ENTRY_TTL_MS) {
        this.pending.delete(requestId);
        this.registry.completeToolRequestError(entry.sessionId, requestId, '执行端不在线或版本过旧，无法读取本机文件');
      }
    }
  }
}

function sizeError(maxBytes: number): string {
  return `文件过大，上限 ${Math.floor(maxBytes / (1024 * 1024))}MB`;
}

async function offlineErrorOf(future: Promise<string>): Promise<string> {
  try {
    const parsed = JSON.parse(await future) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
  } catch { /* fall through */ }
  return '执行端不在线或版本过旧，无法读取本机文件';
}
