import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  MAX_DIMENSION,
  PromptImageResizer,
  STORE_COMPRESS_THRESHOLD_BYTES,
  STORE_TARGET_BYTES,
} from './prompt-image-resizer.js';

/** 确定性随机的纯噪声图：PNG 体积大，最适合验证压缩行为。 */
function noiseRaw(width: number, height: number, channels: number): Buffer {
  return randomBytes(width * height * channels);
}

async function noisePng(width: number, height: number, channels = 3): Promise<Buffer> {
  return sharp(noiseRaw(width, height, channels), {
    raw: { width, height, channels: channels as 3 | 4 },
  }).png().toBuffer();
}

describe('PromptImageResizer.compressForStore', () => {
  it('returns small images untouched (no lossy re-encode)', async () => {
    const input = await noisePng(200, 200);
    expect(input.length).toBeLessThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const result = await PromptImageResizer.compressForStore(input, 'image/png');
    expect(result.resized).toBe(false);
    expect(result.bytes.equals(input)).toBe(true);
    expect(result.mime).toBe('image/png');
  });

  it('compresses large images towards the byte target', async () => {
    const input = await noisePng(1200, 1200);
    expect(input.length).toBeGreaterThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const result = await PromptImageResizer.compressForStore(input, 'image/png');
    expect(result.resized).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(result.bytes.length).toBeLessThanOrEqual(STORE_TARGET_BYTES);
    expect(result.bytes.length).toBeLessThan(input.length);
  });

  it('keeps alpha images as webp', async () => {
    // 900x900 RGBA 噪声 PNG ≈ 3.2MB，稳定高于 1.5MB 阈值（600x600 只有 ~1.4MB，会落在阈值内）
    const input = await noisePng(900, 900, 4);
    expect(input.length).toBeGreaterThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const result = await PromptImageResizer.compressForStore(input, 'image/png');
    expect(result.resized).toBe(true);
    expect(result.mime).toBe('image/webp');
  });

  it('clamps oversized dimensions even when the byte size is small', async () => {
    const input = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    expect(input.length).toBeLessThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const result = await PromptImageResizer.compressForStore(input, 'image/png');
    expect(result.resized).toBe(true);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_DIMENSION);
  });

  it('is deterministic for the same input', async () => {
    const input = await noisePng(900, 900);
    const first = await PromptImageResizer.compressForStore(input, 'image/png');
    const second = await PromptImageResizer.compressForStore(input, 'image/png');
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(second.mime).toBe(first.mime);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  it('rejects empty or invalid input', async () => {
    await expect(PromptImageResizer.compressForStore(Buffer.alloc(0))).rejects.toThrow(/Empty image/);
    await expect(PromptImageResizer.compressForStore(Buffer.from('not an image'))).rejects.toThrow();
  });

  it('reports rotated dimensions for EXIF images through the lossy path', async () => {
    // 1600x900 噪声 + orientation=6（展示时旋转 90° → 900x1600），体积 > 1.5MB 走有损压缩。
    const input = await sharp(randomBytes(1600 * 900 * 3), { raw: { width: 1600, height: 900, channels: 3 } })
      .jpeg({ quality: 100 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(input.length).toBeGreaterThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const result = await PromptImageResizer.compressForStore(input, 'image/jpeg');
    expect(result.resized).toBe(true);
    expect(result.height).toBeGreaterThan(result.width);
    const encoded = await sharp(result.bytes).metadata();
    expect(result.width).toBe(encoded.width);
    expect(result.height).toBe(encoded.height);
  });

  it('honours EXIF orientation when sizing (rotated phone photos)', async () => {
    // 像素是 3000x1000，EXIF orientation=6 表示展示时旋转 90° → 实际竖图 1000x3000。
    const input = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: { r: 12, g: 24, b: 36 } },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await PromptImageResizer.resizeForPrompt(input, 'image/jpeg');
    expect(result.height).toBeGreaterThan(result.width);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_DIMENSION);
  });
});

describe('PromptImageResizer.compressDataUriForStore', () => {
  it('compresses large data URIs to the store target', async () => {
    const input = await noisePng(1200, 1200);
    const uri = `data:image/png;base64,${input.toString('base64')}`;
    const compressed = await PromptImageResizer.compressDataUriForStore(uri);
    expect(compressed.startsWith('data:image/jpeg;base64,')).toBe(true);
    const bytes = Buffer.from(compressed.slice(compressed.indexOf(',') + 1), 'base64');
    expect(bytes.length).toBeLessThanOrEqual(STORE_TARGET_BYTES);
  });

  it('leaves small data URIs unchanged', async () => {
    const input = await noisePng(200, 200);
    const uri = `data:image/png;base64,${input.toString('base64')}`;
    expect(await PromptImageResizer.compressDataUriForStore(uri)).toBe(uri);
  });

  it('returns original value for non data URI or undecodable payload', async () => {
    expect(await PromptImageResizer.compressDataUriForStore('https://example.com/a.png'))
      .toBe('https://example.com/a.png');
    expect(await PromptImageResizer.compressDataUriForStore('data:image/png;base64,abc'))
      .toBe('data:image/png;base64,abc');
  });
});
