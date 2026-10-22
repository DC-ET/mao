import { harnessLog } from '../log.js';
import { ImageFileSupport } from '../tool/image-file-support.js';
import { PromptImageResizer, STORE_TARGET_BYTES } from '../tool/prompt-image-resizer.js';

/**
 * 远程图片下载/压缩缓存（技术方案 2026-10-22 §7.2）。
 *
 * 桌面/Web 上传的图片以 URL 形式进入消息，适配器每轮都要下载并转 data URI。
 * 同一个 URL 在多轮里内容不变，因此：
 * - 首次下载后压缩到 ≤1.2MB 并缓存 data URI；
 * - 后续命中直接复用，不下载、不重编码（输出字节稳定，不破坏前缀缓存）；
 * - 缓存过期后带 ETag/Last-Modified 做条件请求：304 复用旧值，200 重新压缩；
 * - 网络/解析失败回退旧值，保证可用性不受缓存影响。
 *
 * 进程内 LRU，按 data URI 字符数计算占用；重启后重新计算，但同一输入字节一致。
 */

/** 单张远程图片压缩目标：与写入侧同口径 ≤1.2MB（超出即压到目标，留 base64 与前缀缓存余量）。 */
export const REMOTE_IMAGE_TARGET_BYTES = STORE_TARGET_BYTES;
/** 缓存总占用上限（按 data URI 字符数近似字节数）。 */
export const REMOTE_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 缓存有效期：过期后做一次条件请求校验内容是否变化。 */
export const REMOTE_IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
/** 单次下载/校验超时：避免上游挂住时 inflight 永不释放。 */
export const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 20 * 1000;
/** 404/410 负缓存时长：已删除的图不再每轮重新下载（尤其域名不可达时每张要等满超时）。 */
export const REMOTE_IMAGE_MISSING_TTL_MS = 5 * 60 * 1000;
/** 传输层失败（超时/DNS/连接拒绝）的负缓存时长：短期不再重试，避免每轮都等满超时。 */
export const REMOTE_IMAGE_TRANSPORT_FAILURE_TTL_MS = 60 * 1000;

export interface RemoteImageCacheOptions {
  maxBytes?: number;
  ttlMs?: number;
  targetBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 下载失败时带上状态码，便于区分「内容已删除」与「临时故障」。 */
class RemoteImageHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status} when downloading image`);
  }
}

interface CacheEntry {
  dataUri: string;
  size: number;
  etag: string | null;
  lastModified: string | null;
  storedAt: number;
}

export class RemoteImageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  /** url → { error, until }：短期负缓存（404/410 与传输层失败），避免每轮重复打网络。 */
  private readonly missing = new Map<string, { error: Error; until: number }>();
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly targetBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | null;
  private readonly now: () => number;
  private usedBytes = 0;

  constructor(options: RemoteImageCacheOptions = {}) {
    this.maxBytes = Math.max(1, options.maxBytes ?? REMOTE_IMAGE_CACHE_MAX_BYTES);
    this.ttlMs = Math.max(0, options.ttlMs ?? REMOTE_IMAGE_CACHE_TTL_MS);
    this.targetBytes = Math.max(1, options.targetBytes ?? REMOTE_IMAGE_TARGET_BYTES);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? REMOTE_IMAGE_FETCH_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? null;
    this.now = options.now ?? Date.now;
  }

  get sizeBytes(): number {
    return this.usedBytes;
  }

  get count(): number {
    return this.entries.size;
  }

  /** 返回可直接放进请求体的 data URI；失败时抛错，由调用方回退原 URL。 */
  async resolve(imageUrl: string): Promise<string> {
    const missing = this.missing.get(imageUrl);
    if (missing != null) {
      if (this.now() < missing.until) throw missing.error;
      this.missing.delete(imageUrl);
    }
    const cached = this.entries.get(imageUrl);
    if (cached != null) {
      if (this.now() - cached.storedAt < this.ttlMs) {
        this.touch(imageUrl, cached);
        return cached.dataUri;
      }
      // 过期：条件请求校验（同 URL 的并发请求合并到一次校验）。
      return this.load(imageUrl, cached);
    }
    const pending = this.inflight.get(imageUrl);
    if (pending != null) return pending;
    return this.load(imageUrl, null);
  }

  private load(imageUrl: string, stale: CacheEntry | null): Promise<string> {
    const pending = this.inflight.get(imageUrl);
    if (pending != null) return pending;
    const task = this.fetchAndEncode(imageUrl, stale)
      .finally(() => { this.inflight.delete(imageUrl); });
    this.inflight.set(imageUrl, task);
    return task;
  }

  private async fetchAndEncode(imageUrl: string, stale: CacheEntry | null): Promise<string> {
    const headers: Record<string, string> = {};
    if (stale?.etag != null) headers['if-none-match'] = stale.etag;
    if (stale?.lastModified != null) headers['if-modified-since'] = stale.lastModified;
    const doFetch = this.fetchImpl ?? fetch;
    try {
      const res = await doFetch(imageUrl, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 304 && stale != null) {
        this.put(imageUrl, stale.dataUri, stale.etag, stale.lastModified);
        return stale.dataUri;
      }
      if (!res.ok) throw new RemoteImageHttpError(res.status);
      const bytes = Buffer.from(await res.arrayBuffer());
      const declaredMime = res.headers.get('content-type')?.split(';')[0] ?? null;
      const mimeType = ImageFileSupport.resolveImageMime(bytes, declaredMime, imageUrl);
      if (!mimeType) {
        throw new Error(`Downloaded content is not a supported image type (Content-Type=${declaredMime})`);
      }
      // 压缩是尽力而为：解码/编码失败时退回原始字节（与改造前 tryResizeForPrompt 的回退一致）。
      let dataUri: string;
      try {
        const compressed = await PromptImageResizer.compressForStore(bytes, mimeType, {
          thresholdBytes: this.targetBytes,
          targetBytes: this.targetBytes,
        });
        dataUri = compressed.toDataUri();
      } catch (e) {
        harnessLog('warn', `Remote image compress failed, embedding raw bytes: ${(e as Error).message}`);
        dataUri = `data:${mimeType};base64,${bytes.toString('base64')}`;
      }
      this.missing.delete(imageUrl);
      this.put(
        imageUrl,
        dataUri,
        res.headers.get('etag'),
        res.headers.get('last-modified'),
      );
      return dataUri;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      // 内容已删除（404/410）：丢弃缓存并记 5 分钟负缓存，让调用方回退原始 URL，不要一直返回旧图。
      if (e instanceof RemoteImageHttpError && (e.status === 404 || e.status === 410)) {
        this.drop(imageUrl);
        this.markMissing(imageUrl, error, REMOTE_IMAGE_MISSING_TTL_MS);
        throw error;
      }
      if (stale != null) {
        // 校验失败沿用旧值，只延长 TTL，避免每轮都打网络。
        this.put(imageUrl, stale.dataUri, stale.etag, stale.lastModified);
        harnessLog('warn', `Remote image revalidate failed, reusing cached copy: ${error.message}`);
        return stale.dataUri;
      }
      // 冷启动就失败（超时/DNS/5xx）：短负缓存，避免同一次执行的每个工具轮都等满超时。
      this.markMissing(imageUrl, error, REMOTE_IMAGE_TRANSPORT_FAILURE_TTL_MS);
      throw error;
    }
  }

  private put(imageUrl: string, dataUri: string, etag: string | null, lastModified: string | null): void {
    const previous = this.entries.get(imageUrl);
    if (previous != null) this.usedBytes -= previous.size;
    const entry: CacheEntry = {
      dataUri,
      size: dataUri.length,
      etag,
      lastModified,
      storedAt: this.now(),
    };
    // Map 保持插入顺序：先删后插即是 LRU 的「最近使用在末尾」。
    this.entries.delete(imageUrl);
    this.entries.set(imageUrl, entry);
    this.usedBytes += entry.size;
    this.evict();
  }

  private markMissing(imageUrl: string, error: Error, ttlMs: number): void {
    if (this.missing.size >= 512) {
      const oldest = this.missing.keys().next();
      if (oldest.done !== true) this.missing.delete(oldest.value);
    }
    this.missing.set(imageUrl, { error, until: this.now() + ttlMs });
  }

  private drop(imageUrl: string): void {
    const entry = this.entries.get(imageUrl);
    if (entry == null) return;
    this.entries.delete(imageUrl);
    this.usedBytes -= entry.size;
  }

  private touch(imageUrl: string, entry: CacheEntry): void {
    this.entries.delete(imageUrl);
    this.entries.set(imageUrl, entry);
  }

  private evict(): void {
    while (this.usedBytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (entry != null) this.usedBytes -= entry.size;
    }
  }
}

/** 适配器共享的进程级缓存：三个协议实现同一 URL 只下载/压缩一次。 */
export const remoteImageCache = new RemoteImageCache();
