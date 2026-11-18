import { Buffer } from 'node:buffer';
import { lookup as mimeLookup } from 'mime-types';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

/** 分片上限（原始字节/片）：base64 后 ≈683KB，序列化整帧 < 服务端 1MB maxPayload（方案 2026-11-18 §4）。 */
export const FILE_FETCH_CHUNK_BYTES = 512 * 1024;
/** 单文件字节上限：超出直接拒绝（执行端同口径二次校验）。 */
export const FILE_FETCH_MAX_BYTES = 10 * 1024 * 1024;
/** 分片总数上限（10MB / 512KB）。 */
export const FILE_FETCH_MAX_CHUNKS = 20;
/** 总超时：覆盖读盘 + 20 片可靠回传（方案 D4）。超时由 fetch 侧 race 收敛。 */
export const FILE_FETCH_TIMEOUT_SECONDS = 15;
/** per-user 在途软上限（方案 D11）：兜拼装缓冲内存上界，超出立即报错。 */
export const FILE_FETCH_MAX_INFLIGHT_PER_USER = 8;
/** 惰性 TTL 清扫阈值：条目正常由 fetch() finally 必删（成功/超时全路径），此处只兜异常路径。 */
const FETCH_ENTRY_TTL_MS = 30_000;

/** 图片扩展名白名单（仅位图；svg 有脚本执行面与直接导航面，排除）。agent-cli 侧有同表镜像，改动须双端同步。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

export interface LocalFileFetchResult {
  bytes: Buffer;
  fileName: string;
  mime: string;
}

export type LocalFileFetchOutcome =
  | ({ ok: true } & LocalFileFetchResult)
  | { ok: false; error: string };

/** `file_fetch_result` 入站帧的松散形状：字段合法性由 handleChunk 逐项校验，不合法静默丢弃。 */
export interface LocalFileFetchChunkFrame {
  seq?: unknown;
  total?: unknown;
  data?: unknown;
  error?: unknown;
}

interface PendingFetchEntry {
  sessionId: number;
  userId: number;
  fileName: string;
  mime: string;
  chunks: (Buffer | undefined)[];
  total: number | null;
  received: number;
  createdAt: number;
  /** 首片来源连接：未绑定会话用户级广播下多执行端都可能响应，锁定单来源防交织拼坏图（方案 §8-14）。 */
  sourceSocketId: string | null;
}

/**
 * LOCAL 正文图片按需委托读取（方案 2026-11-18）：
 * 路由侧 fetch() 下发 `file_fetch` 并等待；执行端经 `file_fetch_result` 分片回传，
 * 本服务拼装完成后一次性 `registry.completeToolRequest` 回填 registry future。
 * 完整字节只在内存缓冲，服务端不落盘不存库；registry 语义零变化（future 只见最终 JSON 字符串）。
 */
export class LocalFileFetchService {
  private readonly pending = new Map<string, PendingFetchEntry>();

  constructor(private readonly registry: LocalToolSessionRegistry) {}

  /**
   * 按需读取会话工作区内的图片文件。失败一律以 `{ ok: false, error }` 返回（HTTP 200 错误信封口径），
   * 不抛异常——调用方（workspace-download）按文案转 BusinessException。
   */
  async fetch(
    sessionId: number,
    userId: number,
    relativePath: string,
    workspace: string | null | undefined,
  ): Promise<LocalFileFetchOutcome> {
    this.sweepExpired();
    const validationError = validateRelativeImagePath(relativePath);
    if (validationError != null) return { ok: false, error: validationError };
    if (this.countInFlightForUser(userId) >= FILE_FETCH_MAX_INFLIGHT_PER_USER) {
      return { ok: false, error: '图片读取请求过多，请稍后重试' };
    }
    const pending = await this.registry.sendFileRequest(sessionId, relativePath, workspace ?? null);
    const fileName = fileNameOf(relativePath);
    const mime = mimeOf(relativePath);
    if (pending.requestId == null) {
      // 离线 / 投递落空：registry 已立即 resolve 错误 future（file fetch 专属文案），无需登记
      const parsed = JSON.parse(await pending.future) as { error?: string };
      return {
        ok: false,
        error: typeof parsed.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : '本地执行端未连接，无法读取本地文件',
      };
    }
    const entry: PendingFetchEntry = {
      sessionId,
      userId,
      fileName,
      mime,
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
          timer = setTimeout(() => reject(new Error('timeout')), FILE_FETCH_TIMEOUT_SECONDS * 1000);
        }),
      ]);
      const parsed = JSON.parse(finalJson) as { base64?: string; error?: string };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        return { ok: false, error: parsed.error };
      }
      const bytes = typeof parsed.base64 === 'string' && parsed.base64.length > 0
        ? Buffer.from(parsed.base64, 'base64')
        : Buffer.alloc(0);
      if (bytes.length === 0) return { ok: false, error: '图片内容为空' };
      if (bytes.length > FILE_FETCH_MAX_BYTES) return { ok: false, error: '图片过大，无法在对话中展示' };
      return { ok: true, bytes, fileName, mime };
    } catch (e) {
      // 超时（或结果 JSON 异常的兜底）：收敛 registry pending 并报错，不留悬挂请求
      const error = e instanceof Error && e.message === 'timeout'
        ? '图片读取超时，请稍后重试'
        : '图片读取失败，请稍后重试';
      this.pending.delete(pending.requestId);
      this.registry.completeToolRequestError(sessionId, pending.requestId, error);
      return { ok: false, error };
    } finally {
      if (timer) clearTimeout(timer);
      // 全路径必删（成功时 handleChunk 已删，幂等）：迟到分片经 handleChunk 的 Map 未命中静默丢弃
      this.pending.delete(pending.requestId);
    }
  }

  /**
   * `file_fetch_result` 入站处理（StreamingWsHandler 校验会话归属后调用）。
   * 以自持 active Map 判定活跃：未命中静默丢弃（迟到帧 / 超时后分片 / mao-agent 截断存根帧）。
   * `socketId` 为发送方连接：首片到达即锁定来源，异源分片静默丢弃——未绑定会话用户级广播下
   * 多执行端都可能响应，不锁定可能交织拼出损坏图片（方案 §8-14 先到者完成拼装）。
   */
  handleChunk(sessionId: number, requestId: string, frame: LocalFileFetchChunkFrame, socketId?: string | null): void {
    const entry = this.pending.get(requestId);
    if (entry == null || entry.sessionId !== sessionId) return;
    if (entry.sourceSocketId == null) entry.sourceSocketId = socketId ?? null;
    else if (socketId != null && entry.sourceSocketId !== socketId) return;
    // 可选 error 帧：仅在该 requestId 尚未收到任何分片时接受——防异机多执行端竞争误杀合法分片（方案 §4）
    if (typeof frame.error === 'string' && frame.error.length > 0) {
      if (entry.received === 0) {
        this.pending.delete(requestId);
        this.registry.completeToolRequestError(sessionId, requestId, frame.error);
      }
      return;
    }
    const total = typeof frame.total === 'number' && Number.isInteger(frame.total) ? frame.total : 0;
    const seq = typeof frame.seq === 'number' && Number.isInteger(frame.seq) ? frame.seq : 0;
    const data = typeof frame.data === 'string' ? frame.data : '';
    if (total < 1 || total > FILE_FETCH_MAX_CHUNKS || seq < 1 || seq > total) return;
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
    if (chunk.length === 0 || chunk.length > FILE_FETCH_CHUNK_BYTES) return;
    entry.chunks[seq - 1] = chunk;
    entry.received += 1;
    if (entry.received < entry.total) return;
    // 拼装完成：一次性回填 registry future（final JSON 只含 base64，registry 语义零变化）
    this.pending.delete(requestId);
    const bytes = Buffer.concat(entry.chunks as Buffer[]);
    this.registry.completeToolRequest(sessionId, requestId, JSON.stringify({ base64: bytes.toString('base64') }));
  }

  private countInFlightForUser(userId: number): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.userId === userId) count += 1;
    }
    return count;
  }

  /** 惰性 TTL 清扫：兜 fetch 已返回但缓冲仍残留的异常路径（对齐方案 §4 生命周期）。 */
  private sweepExpired(now = Date.now()): void {
    for (const [requestId, entry] of this.pending) {
      if (now - entry.createdAt > FETCH_ENTRY_TTL_MS) {
        this.pending.delete(requestId);
        this.registry.completeToolRequestError(entry.sessionId, requestId, '图片读取超时，请稍后重试');
      }
    }
  }
}

/** 服务端前置校验（方案 D5）：相对路径、`/` 分隔（拒反斜杠 / 绝对 / `..` / 盘符）、图片扩展名白名单。 */
export function validateRelativeImagePath(relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) return '缺少图片路径';
  if (relativePath.length > 512) return '图片路径过长';
  if (relativePath.includes('\\')) return '图片路径不合法';
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) return '图片路径不合法';
  const segments = relativePath.split('/');
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg.includes(':'))) {
    return '图片路径不合法';
  }
  const ext = segments[segments.length - 1].split('.').pop()?.toLowerCase() ?? '';
  if (!IMAGE_EXTENSIONS.has(ext)) return '仅支持图片文件（png/jpg/jpeg/gif/webp/bmp/avif）';
  return null;
}

/** 扩展名白名单判定（取扩展名口径与 validateRelativeImagePath 一致）：路由分流用——非图片不进委托，保持 2026-11-17 的明确拒绝文案。 */
export function hasImageFileExtension(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const ext = segments[segments.length - 1].split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

function fileNameOf(relativePath: string): string {
  const segments = relativePath.split('/');
  return segments[segments.length - 1] || 'image';
}

function mimeOf(relativePath: string): string {
  return mimeLookup(fileNameOf(relativePath)) || 'application/octet-stream';
}
