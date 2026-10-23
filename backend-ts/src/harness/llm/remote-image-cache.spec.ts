import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_IMAGE_CACHE_TTL_MS,
  REMOTE_IMAGE_TARGET_BYTES,
  RemoteImageCache,
} from './remote-image-cache.js';

function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function imageResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  });
}

function uriBytes(dataUri: string): number {
  return Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64').length;
}

describe('RemoteImageCache', () => {
  it('downloads and compresses once, then serves from cache without fetching', async () => {
    const source = await noisePng(1200, 1200);
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(source, { etag: '"v1"' }));
    const cache = new RemoteImageCache({ fetchImpl });

    const first = await cache.resolve('https://cdn.example.com/a.png');
    const second = await cache.resolve('https://cdn.example.com/a.png');

    expect(first).toBe(second);
    expect(first.startsWith('data:image/')).toBe(true);
    expect(uriBytes(first)).toBeLessThanOrEqual(REMOTE_IMAGE_TARGET_BYTES);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.count).toBe(1);
  });

  it('revalidates with ETag after TTL and reuses cached bytes on 304', async () => {
    let now = 0;
    const source = await noisePng(400, 400);
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(source, { etag: '"v1"' }));
    const cache = new RemoteImageCache({ fetchImpl, now: () => now });

    const first = await cache.resolve('https://cdn.example.com/b.png');
    now += REMOTE_IMAGE_CACHE_TTL_MS + 1;
    fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 304 }));
    const second = await cache.resolve('https://cdn.example.com/b.png');

    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = fetchImpl.mock.calls[1][1];
    expect((init?.headers as Record<string, string>)['if-none-match']).toBe('"v1"');
  });

  it('replaces cached bytes when content changed (200)', async () => {
    let now = 0;
    const firstBytes = await noisePng(600, 600);
    const secondBytes = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 250, g: 10, b: 10 } },
    }).png().toBuffer();
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(firstBytes));
    const cache = new RemoteImageCache({ fetchImpl, now: () => now });

    const first = await cache.resolve('https://cdn.example.com/c.png');
    now += REMOTE_IMAGE_CACHE_TTL_MS + 1;
    fetchImpl.mockImplementationOnce(async () => imageResponse(secondBytes));
    const second = await cache.resolve('https://cdn.example.com/c.png');

    expect(second).not.toBe(first);
    expect(uriBytes(second)).toBeLessThanOrEqual(REMOTE_IMAGE_TARGET_BYTES);
  });

  it('falls back to the cached copy when revalidation fails', async () => {
    let now = 0;
    const source = await noisePng(300, 300);
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(source));
    const cache = new RemoteImageCache({ fetchImpl, now: () => now });

    const first = await cache.resolve('https://cdn.example.com/d.png');
    now += REMOTE_IMAGE_CACHE_TTL_MS + 1;
    fetchImpl.mockImplementationOnce(async () => { throw new Error('network down'); });
    const second = await cache.resolve('https://cdn.example.com/d.png');

    expect(second).toBe(first);
  });

  it('surfaces fetch failures on cold misses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
    const cache = new RemoteImageCache({ fetchImpl });
    await expect(cache.resolve('https://cdn.example.com/e.png')).rejects.toThrow(/HTTP 500/);
    expect(cache.count).toBe(0);
  });

  it('embeds raw bytes when the image cannot be decoded', async () => {
    // 只有 magic bytes、无法被 sharp 解码的图：仍应转成 data URI，而不是丢掉图片。
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(pngMagic), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const cache = new RemoteImageCache({ fetchImpl });
    expect(await cache.resolve('https://cdn.example.com/g.png'))
      .toBe(`data:image/png;base64,${pngMagic.toString('base64')}`);
  });

  it('drops the cached copy when the image is gone (404)', async () => {
    let now = 0;
    const source = await noisePng(300, 300);
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(source));
    const cache = new RemoteImageCache({ fetchImpl, now: () => now });

    await cache.resolve('https://cdn.example.com/h.png');
    now += REMOTE_IMAGE_CACHE_TTL_MS + 1;
    fetchImpl.mockImplementationOnce(async () => new Response('gone', { status: 404 }));
    await expect(cache.resolve('https://cdn.example.com/h.png')).rejects.toThrow(/HTTP 404/);
    expect(cache.count).toBe(0);
  });

  it('negative-caches 404 so repeated rounds do not refetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('gone', { status: 404 }));
    const cache = new RemoteImageCache({ fetchImpl });
    await expect(cache.resolve('https://cdn.example.com/i.png')).rejects.toThrow(/HTTP 404/);
    await expect(cache.resolve('https://cdn.example.com/i.png')).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('negative-caches transport failures so a hung domain is not retried every round', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('connect ETIMEDOUT'); });
    const cache = new RemoteImageCache({ fetchImpl });
    await expect(cache.resolve('https://dead.example.com/j.png')).rejects.toThrow(/ETIMEDOUT/);
    await expect(cache.resolve('https://dead.example.com/j.png')).rejects.toThrow(/ETIMEDOUT/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('evicts least recently used entries by byte budget', async () => {
    const small = await noisePng(120, 120);
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(small));
    const probe = new RemoteImageCache({ fetchImpl });
    await probe.resolve('https://cdn.example.com/probe.png');
    const entryBytes = probe.sizeBytes;
    expect(entryBytes).toBeGreaterThan(0);

    const cache = new RemoteImageCache({ fetchImpl, maxBytes: entryBytes * 2 });
    fetchImpl.mockClear();
    await cache.resolve('https://cdn.example.com/1.png');
    await cache.resolve('https://cdn.example.com/2.png');
    await cache.resolve('https://cdn.example.com/1.png'); // 命中：1 变为最近使用
    await cache.resolve('https://cdn.example.com/3.png'); // 触发淘汰最久未用的 2

    expect(cache.count).toBe(2);
    expect(cache.sizeBytes).toBeLessThanOrEqual(entryBytes * 2);
    // 2 已被淘汰 → 再次访问需重新下载；1 仍在缓存 → 不下载。
    await cache.resolve('https://cdn.example.com/2.png');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('deduplicates concurrent downloads of the same URL', async () => {
    const source = await noisePng(200, 200);
    let resolveFetch!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const cache = new RemoteImageCache({ fetchImpl });

    const pending = Promise.all([
      cache.resolve('https://cdn.example.com/f.png'),
      cache.resolve('https://cdn.example.com/f.png'),
    ]);
    resolveFetch(imageResponse(source));
    const [a, b] = await pending;

    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
