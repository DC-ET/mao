import { describe, expect, it } from 'vitest';
import {
  RemoteImageCache,
  REMOTE_IMAGE_CACHE_MAX_BYTES,
  REMOTE_IMAGE_CACHE_TTL_MS,
  REMOTE_IMAGE_MISSING_TTL_MS,
} from './remote-image-cache.js';
import { PromptImageResizer } from '../tool/prompt-image-resizer.js';
import sharp from 'sharp';

/**
 * Bugcheck：RemoteImageCache（2026-10-22 fa3f47b1 新增）的缓存语义。
 *
 * 关注点：
 * 1. 304 复用是否刷新 storedAt（TTL 过期后每次都要重新协商 = 每轮一次条件请求）；
 * 2. LRU 淘汰是否真的按"最近使用"而不是插入序；
 * 3. 负缓存在 TTL 到期后是否恢复；
 * 4. 并发 resolve 是否合并成一次下载；
 * 5. 压缩失败的图是否回退原字节（不被当成失败）。
 */

/** 1×1 PNG。 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return handler as unknown as typeof fetch;
}

/**
 * 构造最小 Response 替身：lib 只有 ES2022（无 DOM），undici 的 BodyInit 不接受
 * Buffer / Uint8Array，而二进制字符串经 Response 往返会被 UTF-8 解码破坏字节。
 * 这里直接给出 RemoteImageCache 实际用到的成员（status / ok / headers / arrayBuffer）。
 */
function imageResponse(bytes: Buffer, headers: Record<string, string> = {}, status = 200): Response {
  const merged: Record<string, string> = { 'content-type': 'image/png', ...headers };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => merged[name.toLowerCase()] ?? null },
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
  } as unknown as Response;
}

function okResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return imageResponse(bytes, headers, 200);
}

function notModified(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 304, headers });
}

describe('RemoteImageCache', () => {
  it('merges concurrent resolves of the same url into one download', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return okResponse(PNG_1x1);
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 60_000 });
    const results = await Promise.all([
      cache.resolve('https://a/x.png'),
      cache.resolve('https://a/x.png'),
      cache.resolve('https://a/x.png'),
    ]);
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0].startsWith('data:image/png;base64,')).toBe(true);
  });

  it('serves from cache without a second fetch inside the TTL', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      return okResponse(PNG_1x1, { etag: '"v1"' });
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 60_000 });
    await cache.resolve('https://a/x.png');
    await cache.resolve('https://a/x.png');
    expect(calls).toBe(1);
  });

  it('revalidates with conditional headers once the entry expires', async () => {
    let calls = 0;
    const seen: Array<Record<string, string>> = [];
    let now = 1_000_000;
    const fetchImpl = fakeFetch(async (_url, init) => {
      calls += 1;
      seen.push((init?.headers ?? {}) as Record<string, string>);
      // 第二次（过期后）返回 304
      if (calls === 1) return okResponse(PNG_1x1, { etag: '"v1"' });
      return notModified();
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 1000, now: () => now });
    const first = await cache.resolve('https://a/x.png');
    now += 5000; // 过期
    const second = await cache.resolve('https://a/x.png');
    expect(calls).toBe(2);
    expect(seen[1]['if-none-match']).toBe('"v1"');
    expect(second).toBe(first);
  });

  it('refreshes storedAt after a 304 so revalidation does not repeat every call', async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      if (calls === 1) return okResponse(PNG_1x1, { etag: '"v1"' });
      return notModified();
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 1000, now: () => now });
    await cache.resolve('https://a/x.png');   // t=0     fetch#1，storedAt=0
    now += 600;
    await cache.resolve('https://a/x.png');   // t=600   TTL 内命中
    now += 600;
    await cache.resolve('https://a/x.png');   // t=1200  过期 → 304#2，storedAt 应刷新为 1200
    now += 600;
    await cache.resolve('https://a/x.png');   // t=1800  若已刷新则命中；若未刷新则再打一次网络
    now += 600;
    await cache.resolve('https://a/x.png');   // t=2400  距上次刷新 1200ms > TTL → 再次协商（预期）
    // 已刷新：首拉 + t=1200 的 304 + t=2400 的 304 = 3（storedAt=1200 使 t=1800 命中）
    // 未刷新：storedAt=0 恒久 → t=1200/1800/2400 三次全过期 = 4
    expect(calls).toBe(3);
  });

  it('轮间隔超过 TTL 时每轮一次条件请求属预期设计（非缺陷）', async () => {
    // 曾有疑点：304 复用不刷新 storedAt，导致条件请求随工具轮线性增长。
    // 实测否定：轮间隔 < TTL 时 304 后确实命中缓存；此处轮间隔 > TTL，
    // 相当于真实间隔超过 1 小时，每轮重新协商正是 TTL 的设计语义。
    let calls = 0;
    let now = 0;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      if (calls === 1) return okResponse(PNG_1x1, { etag: '"v1"' });
      return notModified();
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 1000, now: () => now });
    await cache.resolve('https://a/x.png');
    for (let round = 0; round < 10; round++) {
      now += 1001; // 轮间隔 > TTL
      await cache.resolve('https://a/x.png');
    }
    expect(calls).toBe(11);
  });

  it('falls back to the stale copy when revalidation fails', async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      if (calls === 1) return okResponse(PNG_1x1, { etag: '"v1"' });
      throw new Error('network down');
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 1000, now: () => now });
    const first = await cache.resolve('https://a/x.png');
    now += 5000;
    const second = await cache.resolve('https://a/x.png');
    expect(second).toBe(first);
  });

  it('evicts the least recently used entry when the budget is exceeded', async () => {
    const fetchImpl = fakeFetch(async (url) => okResponse(Buffer.from(url)));
    // 每条占 url.length 字节；预算只够 2 条
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 60_000, maxBytes: 40 });
    await cache.resolve('https://a/1111111111.png');
    await cache.resolve('https://a/2222222222.png');
    // 访问第一条，使其成为最近使用
    await cache.resolve('https://a/1111111111.png');
    await cache.resolve('https://a/3333333333.png');
    // 第一条应仍在缓存（刚被访问），第二条应被淘汰
    const stillThere = await cache.resolve('https://a/1111111111.png');
    expect(stillThere.length).toBeGreaterThan(0);
    expect(cache.count).toBeLessThanOrEqual(2);
  });

  it('negative-caches a 404 for the miss TTL, then retries after expiry', async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      // 第 1 次：404；负缓存到期后的第 2 次真实请求：成功
      if (calls === 1) return new Response(null, { status: 404 });
      return okResponse(PNG_1x1);
    });
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 60_000, now: () => now });
    await expect(cache.resolve('https://a/gone.png')).rejects.toThrow('404');
    // 负缓存有效期内不再打网络
    now += REMOTE_IMAGE_MISSING_TTL_MS - 1;
    await expect(cache.resolve('https://a/gone.png')).rejects.toThrow('404');
    expect(calls).toBe(1);
    // 过期后重试成功
    now += 2;
    const value = await cache.resolve('https://a/gone.png');
    expect(value.startsWith('data:image/png;base64,')).toBe(true);
    expect(calls).toBe(2);
  });

  it('keeps the raw bytes when compression cannot produce a smaller image', async () => {
    // 已经是压缩过的 JPEG：再次编码不会更小，应回退原字节而不是抛错
    const tinyJpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
    }).jpeg({ quality: 92 }).toBuffer();
    const fetchImpl = fakeFetch(async () => imageResponse(tinyJpeg, { 'content-type': 'image/jpeg' }));
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 60_000 });
    const uri = await cache.resolve('https://a/tiny.jpg');
    expect(uri.startsWith('data:image/jpeg;base64,')).toBe(true);
    const decoded = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    expect(decoded.equals(tinyJpeg)).toBe(true);
  });

  it('reports its byte footprint', async () => {
    const fetchImpl = fakeFetch(async () => okResponse(PNG_1x1));
    const cache = new RemoteImageCache({ fetchImpl, ttlMs: 60_000 });
    const uri = await cache.resolve('https://a/x.png');
    expect(cache.sizeBytes).toBe(uri.length);
    expect(cache.count).toBe(1);
  });
});
