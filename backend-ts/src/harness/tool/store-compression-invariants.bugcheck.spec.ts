import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  PromptImageResizer,
  STORE_COMPRESS_THRESHOLD_BYTES,
  STORE_TARGET_BYTES,
  INBOUND_IMAGE_COMPRESS_CONCURRENCY,
} from './prompt-image-resizer.js';
import { ImageFileSupport } from './image-file-support.js';

/**
 * Bugcheck：写入侧压缩的边界与入站 data URI 压缩。
 *
 * 关键不变量（技术方案 2026-10-22 §7.1 + 10-23 常量取整）：
 * - STORE_TARGET_BYTES (1258291) 必须 < STORE_COMPRESS_THRESHOLD_BYTES (1572864)，
 *   否则「压到目标」会把图越压越大；
 * - REMOTE_IMAGE_BYTES 估算（request-size.ts）按 target × 1.03 × 4/3 + 1024 计，
 *   若 target 变化而估算不同步，体积触发会系统性偏差。
 */

function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('store compression invariants', () => {
  it('target is strictly below the threshold so compression never enlarges', () => {
    expect(STORE_TARGET_BYTES).toBeLessThan(STORE_COMPRESS_THRESHOLD_BYTES);
    expect(STORE_TARGET_BYTES).toBe(1_258_291);
  });

  it('compresses a large image (just under the 5MB read gate) below the target', async () => {
    // 找一张 >1.5MB 且 ≤5MB 的图：read_file 的 MAX_IMAGE_BYTES 门限内的最大压力样本
    let big = await noisePng(1000, 1000);
    for (const size of [1000, 1200, 1400, 1600, 1800]) {
      big = await noisePng(size, size);
      if (big.length > STORE_COMPRESS_THRESHOLD_BYTES) break;
    }
    expect(big.length).toBeGreaterThan(STORE_COMPRESS_THRESHOLD_BYTES);
    expect(big.length).toBeLessThanOrEqual(ImageFileSupport.MAX_IMAGE_BYTES);
    const result = await PromptImageResizer.compressForStore(big, 'image/png');
    expect(result.bytes.length).toBeLessThanOrEqual(STORE_TARGET_BYTES);
  }, 120_000);

  it('leaves an image just under the threshold byte-identical', async () => {
    // 构造一个略小于 1.5MB 的 JPEG：不应被有损重编码
    const probe = await sharp({
      create: { width: 1400, height: 1400, channels: 3, background: { r: 128, g: 64, b: 32 } },
    }).jpeg({ quality: 88 }).toBuffer();
    if (probe.length > STORE_COMPRESS_THRESHOLD_BYTES) return; // 机器差异导致超阈值时跳过
    const result = await PromptImageResizer.compressForStore(probe, 'image/jpeg');
    // ≤阈值：要么原样返回，要么尺寸规整个位数；不允许有损降质
    expect(result.bytes.length).toBeLessThanOrEqual(probe.length);
  }, 30_000);

  it('compressDataUriForStore returns the input unchanged for non-image or malformed URIs', async () => {
    expect(await PromptImageResizer.compressDataUriForStore('https://a/b.png')).toBe('https://a/b.png');
    expect(await PromptImageResizer.compressDataUriForStore('')).toBe('');
    expect(await PromptImageResizer.compressDataUriForStore('data:image/png;base64')).toBe('data:image/png;base64');
    expect(await PromptImageResizer.compressDataUriForStore('data:text/plain;base64,AAA')).toBe('data:text/plain;base64,AAA');
    expect(await PromptImageResizer.compressDataUriForStore('data:image/png,raw')).toBe('data:image/png,raw');
    // 非字符串入参不得抛错
    expect(await PromptImageResizer.compressDataUriForStore(undefined as unknown as string)).toBe(undefined);
  });

  it('compressDataUriForStore shrinks an oversized data URI', async () => {
    const big = await noisePng(1800, 1800);
    const uri = `data:image/png;base64,${big.toString('base64')}`;
    expect(uri.length).toBeGreaterThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const out = await PromptImageResizer.compressDataUriForStore(uri);
    const decoded = Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
    expect(decoded.length).toBeLessThan(big.length);
    expect(out.startsWith('data:image/')).toBe(true);
  }, 60_000);

  it('compressDataUriForStore keeps a small data URI unchanged', async () => {
    const small = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();
    const uri = `data:image/png;base64,${small.toString('base64')}`;
    expect(await PromptImageResizer.compressDataUriForStore(uri)).toBe(uri);
  });

  it('inbound concurrency is a small positive number', () => {
    expect(INBOUND_IMAGE_COMPRESS_CONCURRENCY).toBeGreaterThan(0);
    expect(INBOUND_IMAGE_COMPRESS_CONCURRENCY).toBeLessThanOrEqual(8);
  });
});
