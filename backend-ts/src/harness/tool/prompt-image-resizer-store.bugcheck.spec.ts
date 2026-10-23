import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { PromptImageResizer, STORE_TARGET_BYTES } from './prompt-image-resizer.js';

/**
 * Bugcheck：写入侧压缩 compressForStore 的两个可能缺陷。
 *
 * 背景（2026-10-22 fa3f47b1 + 10-23 0637344e / 65d2a32e）：
 * 图片写入侧 >1.5MB 压到 ≤1.2MB（STORE_TARGET_BYTES = 1258291）。
 *
 * 待验证：
 * 1. 压缩结果比原图更大时是否被正确拒绝（"压不小就别压大"）；
 * 2. 尺寸规整这一步（resizeForPrompt）会把原图重编码，若它把 ≤1.5MB 的图放大到
 *    >1.5MB，后续会进入有损压缩循环，可能让"本无需有损"的图被有损化。
 */

/** 生成一张不可无损压缩的大图（PNG，真随机像素 → 体积大且难压缩）。 */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  // crypto 真随机：PNG 无损压缩对随机数据几乎无效，体积随像素数线性增长
  randomBytes(raw.length).copy(raw);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('compressForStore', () => {
  it('keeps the original when compression cannot beat it', async () => {
    // 极小尺寸高质量 JPEG：任何重编码都不可能更小
    const tiny = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } },
    }).jpeg({ quality: 95, mozjpeg: true }).toBuffer();
    expect(tiny.length).toBeLessThan(STORE_TARGET_BYTES);

    const result = await PromptImageResizer.compressForStore(tiny, 'image/jpeg');
    // 阈值内直接原样返回，不做有损重编码
    expect(result.bytes.length).toBe(tiny.length);
    expect(result.resized).toBe(false);
  });

  it('never returns a result larger than the input', async () => {
    const big = await noisyPng(900, 900);
    expect(big.length).toBeGreaterThan(STORE_TARGET_BYTES);
    const result = await PromptImageResizer.compressForStore(big, 'image/png');
    expect(result.bytes.length).toBeLessThanOrEqual(big.length);
  });

  it('respects the 1.2MB target for a compressible image', async () => {
    const big = await noisyPng(1600, 1600);
    expect(big.length).toBeGreaterThan(STORE_TARGET_BYTES);
    const result = await PromptImageResizer.compressForStore(big, 'image/png');
    expect(result.bytes.length).toBeLessThanOrEqual(STORE_TARGET_BYTES);
  });

  it('does not enlarge a small image through size normalization', async () => {
    // 关键回归点：resizeForPrompt 会把非 32 倍数尺寸的图规整并重编码。
    // 若规整后的 PNG 比原图大，compressForStore 必须仍走"原样/有损"路径，
    // 而不能把规整结果当作最终产物写回（写侧体积反而上升）。
    const small = await sharp({
      create: { width: 33, height: 33, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).png().toBuffer();
    expect(small.length).toBeLessThan(STORE_TARGET_BYTES);

    const result = await PromptImageResizer.compressForStore(small, 'image/png');
    expect(result.bytes.length).toBeLessThanOrEqual(small.length);
  });

  // ===== BUG H1：早返回分支只与阈值比，未与原图比 =====
  // prompt-image-resizer.ts:185-187：
  //   const normalized = await this.resizeForPrompt(input, mimeHint);
  //   if (normalized.bytes.length <= thresholdBytes) return normalized;   ← 未与 input.length 比
  // 函数末尾（:209）有"压不小就别压大"的保护，早返回分支没有。
  // resizeForPrompt 走 encodeSpecFor 的 q85 JPEG / PNG 分支：对已是低质量编码的大图，
  // q85 重编码必然变大。产物若仍在 1.5MB 阈值内，就命中早返回被原样写回。
  // 0637344e 把阈值从 500KB 提到 1.5MB 后，这条路径从"不可达"变成"可达"。
  it('BUG H1：低质量大图经 compressForStore 被放大（写侧体积反升）', async () => {
    // 平滑渐变 2048×2048：低质量 JPEG 编码后仅 25KB 级，q85 重编码放大 1.8~2.4 倍
    const raw = Buffer.alloc(2048 * 2048 * 3);
    for (let y = 0; y < 2048; y++) {
      for (let x = 0; x < 2048; x++) {
        const i = (y * 2048 + x) * 3;
        raw[i] = Math.floor((x / 2048) * 255);
        raw[i + 1] = Math.floor((y / 2048) * 255);
        raw[i + 2] = 128;
      }
    }
    const original = await sharp(raw, {
      raw: { width: 2048, height: 2048, channels: 3 },
    }).jpeg({ quality: 5 }).toBuffer();
    expect(original.length).toBeLessThan(STORE_TARGET_BYTES);

    const result = await PromptImageResizer.compressForStore(original, 'image/jpeg');
    // 期望：写侧产物不劣于原图；实际：q85 重编码后显著变大
    expect(result.bytes.length).toBeLessThanOrEqual(original.length);
  });

  it('BUG H1 修复后：写侧产物一律不大于原图', async () => {
    // 修复前：q=5~20 的放大倍数 1.89~2.35×（早返回与循环返回都只跟阈值/目标比）。
    // 修复后：规整产物须同时 ≤ 阈值且 ≤ 原图；循环返回也加 < input.length 条件，
    // 压不小就落到末尾的「保留原图」分支。
    const ratios: number[] = [];
    for (const quality of [5, 10, 15, 20]) {
      const raw = Buffer.alloc(2048 * 2048 * 3);
      for (let y = 0; y < 2048; y++) {
        for (let x = 0; x < 2048; x++) {
          const i = (y * 2048 + x) * 3;
          raw[i] = Math.floor((x / 2048) * 255);
          raw[i + 1] = Math.floor((y / 2048) * 255);
          raw[i + 2] = 128;
        }
      }
      const original = await sharp(raw, {
        raw: { width: 2048, height: 2048, channels: 3 },
      }).jpeg({ quality }).toBuffer();
      const result = await PromptImageResizer.compressForStore(original, 'image/jpeg');
      ratios.push(result.bytes.length / original.length);
    }
    // 期望：任一质量下写侧体积都不劣于原图
    expect(Math.max(...ratios)).toBeLessThanOrEqual(1);
  });
});
