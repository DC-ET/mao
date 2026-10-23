import sharp from 'sharp';
import { ImageFileSupport } from './image-file-support.js';
import { harnessLog } from '../log.js';

export const PATCH_SIZE = 32;
export const MAX_DIMENSION = 2048;
export const MAX_PATCHES = 2500;
export const JPEG_QUALITY = 0.85;

/** 写入侧压缩：超过该字节数才做有损压缩（技术方案 2026-10-22 §7.1）。 */
export const STORE_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024; // 1_572_864
/** 写入侧压缩目标：单图 ≤1.2MB（必须小于触发阈值，否则会把图“压”得更大）。 */
export const STORE_TARGET_BYTES = Math.round(1.2 * 1024 * 1024); // 1_258_291，字节口径保持整数
/** 质量控制档位：先降质量，再缩尺寸。 */
export const STORE_QUALITY_STEPS = [80, 70, 60] as const;
/** 质量降到底仍超目标时，每次缩小的比例。 */
export const STORE_SCALE_STEP = 0.85;
/** 入站多图压缩的并发上限：受控并发避免多张原图同时解码把单进程内存顶到 GB 级。 */
export const INBOUND_IMAGE_COMPRESS_CONCURRENCY = 2;
/** 尺寸回退轮数：3 个质量档 + 3 个缩放档 = 6 次有损编码（尺寸规整另有 1 次，总计 ≤7）。 */
export const STORE_SCALE_ROUNDS = 3;

export interface PromptSize {
  width: number;
  height: number;
}

export class PromptImageResult {
  constructor(
    readonly bytes: Buffer,
    readonly mime: string,
    readonly width: number,
    readonly height: number,
    readonly resized: boolean,
  ) {}

  toDataUri(): string {
    return `data:${this.mime};base64,${this.bytes.toString('base64')}`;
  }
}

export const PromptImageResizer = {
  computeTargetSize(width: number, height: number): PromptSize {
    if (width <= 0 || height <= 0) {
      return { width: Math.max(1, width), height: Math.max(1, height) };
    }
    let w = width;
    let h = height;
    const maxSide = Math.max(w, h);
    if (maxSide > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / maxSide;
      w = Math.floor(w * scale);
      h = Math.floor(h * scale);
      w = Math.max(1, w);
      h = Math.max(1, h);
    }
    const patchW = Math.ceil(w / PATCH_SIZE);
    const patchH = Math.ceil(h / PATCH_SIZE);
    if (patchW * patchH > MAX_PATCHES) {
      const scale = Math.sqrt(MAX_PATCHES / (patchW * patchH));
      let newPatchW = Math.max(1, Math.floor(patchW * scale));
      let newPatchH = Math.max(1, Math.floor(patchH * scale));
      while (newPatchW * newPatchH > MAX_PATCHES) {
        if (newPatchW >= newPatchH && newPatchW > 1) newPatchW--;
        else if (newPatchH > 1) newPatchH--;
        else break;
      }
      return { width: newPatchW * PATCH_SIZE, height: newPatchH * PATCH_SIZE };
    }
    return { width: Math.round(w), height: Math.round(h) };
  },

  fitsPromptLimits(width: number, height: number): boolean {
    if (width <= 0 || height <= 0) return false;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false;
    const patches = Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE);
    return patches <= MAX_PATCHES;
  },

  async resizeForPrompt(input: Buffer, mimeHint?: string | null): Promise<PromptImageResult> {
    if (input == null || input.length === 0) {
      throw new Error('Empty image bytes');
    }
    const declared = ImageFileSupport.normalizeMime(mimeHint);
    const mime = ImageFileSupport.detectMimeFromBytes(input)
      ?? (declared?.startsWith('image/') ? declared : undefined);
    if (!mime) {
      throw new Error('Unsupported or invalid image content');
    }

    let meta: sharp.Metadata;
    try {
      meta = await sharp(input).metadata();
    } catch {
      throw new Error(`Failed to decode image (mime=${mime})`);
    }
    // metadata 不应用 EXIF 方向：带旋转标记的照片宽高是反的，必须先换算再算目标尺寸，
    // 否则会先按横图缩一次、再 rotate 成竖图，多缩一档。
    const src = orientedDimensions(meta);
    const srcW = src.width;
    const srcH = src.height;
    const target = this.computeTargetSize(srcW, srcH);
    if (target.width === srcW && target.height === srcH && this.fitsPromptLimits(srcW, srcH)) {
      return new PromptImageResult(input, mime, srcW, srcH, false);
    }

    const encodeMime = encodeSpecFor(mime);
    let pipeline = sharp(input).rotate().resize(target.width, target.height, { fit: 'fill' });
    let outMime = encodeMime;
    let outBytes: Buffer;
    try {
      if (encodeMime === 'image/jpeg') {
        outBytes = await pipeline.flatten({ background: { r: 0, g: 0, b: 0 } }).jpeg({ quality: Math.round(JPEG_QUALITY * 100) }).toBuffer();
      } else if (encodeMime === 'image/webp') {
        try {
          outBytes = await pipeline.webp().toBuffer();
        } catch {
          outBytes = await sharp(input).rotate().resize(target.width, target.height, { fit: 'fill' }).png().toBuffer();
          outMime = 'image/png';
        }
      } else {
        outBytes = await pipeline.png().toBuffer();
      }
    } catch {
      throw new Error(`Failed to encode resized image as ${encodeMime}`);
    }
    return new PromptImageResult(outBytes, outMime, target.width, target.height, true);
  },

  /** 按 EXIF 方向摆正后的源图尺寸（展示「原图 → 压缩后」用）；解码失败返回 null。 */
  async orientedSize(input: Buffer): Promise<PromptSize | null> {
    try {
      return orientedDimensions(await sharp(input).metadata());
    } catch {
      return null;
    }
  },

  async tryResizeForPrompt(input: Buffer, mimeHint?: string | null): Promise<PromptImageResult | undefined> {
    try {
      return await this.resizeForPrompt(input, mimeHint);
    } catch (e) {
      harnessLog('warn', `Prompt image resize failed: ${(e as Error).message}`);
      return undefined;
    }
  },

  /**
   * 写入侧压缩（技术方案 2026-10-22 §7.1）：
   * - 尺寸合规且 ≤1.5MB → 原样返回，不做有损重编码；
   * - 否则按 1.2MB 目标迭代（质量 80→70→60，再按 0.85 缩尺寸，共 6 次编码；含尺寸规整总计 ≤7）。
   *
   * 只在工具产出图片时调用一次，结果落库后不再重编码（前缀缓存稳定）。
   */
  async compressForStore(
    input: Buffer,
    mimeHint?: string | null,
    opts?: { thresholdBytes?: number; targetBytes?: number },
  ): Promise<PromptImageResult> {
    if (input == null || input.length === 0) {
      throw new Error('Empty image bytes');
    }
    const declared = ImageFileSupport.normalizeMime(mimeHint);
    const mime = ImageFileSupport.detectMimeFromBytes(input)
      ?? (declared?.startsWith('image/') ? declared : undefined);
    if (!mime) {
      throw new Error('Unsupported or invalid image content');
    }

    let meta: sharp.Metadata;
    try {
      meta = await sharp(input).metadata();
    } catch {
      throw new Error(`Failed to decode image (mime=${mime})`);
    }
    const src = orientedDimensions(meta);
    const srcW = src.width;
    const srcH = src.height;
    const target = this.computeTargetSize(srcW, srcH);
    const thresholdBytes = opts?.thresholdBytes ?? STORE_COMPRESS_THRESHOLD_BYTES;
    const targetBytes = opts?.targetBytes ?? STORE_TARGET_BYTES;

    // 先做既有尺寸规整（保持原编码）；结果 ≤1.5MB 就原样使用，不做有损重编码。
    // 这样“仅因尺寸超限”的图仍保持 PNG 无损（与改造前行为一致）。
    // 但规整产物必须同时不大于原图：resizeForPrompt 走 q85 JPEG / PNG 重编码，
    // 对已是低质量编码的图会放大；只与阈值比会把放大后的结果写回，写侧体积反升
    // （与下面循环末尾「压不小就别压大」的保护同口径）。
    const normalized = await this.resizeForPrompt(input, mimeHint);
    if (normalized.bytes.length <= thresholdBytes && normalized.bytes.length <= input.length) {
      return normalized;
    }

    const hasAlpha = meta.hasAlpha === true;
    const outMime = hasAlpha ? 'image/webp' : 'image/jpeg';
    let best: { bytes: Buffer; width: number; height: number } | null = null;
    for (const attempt of buildStoreAttempts(target)) {
      let encoded: { bytes: Buffer; width: number; height: number };
      try {
        encoded = await encodeStore(input, attempt, hasAlpha);
      } catch (e) {
        harnessLog('warn', `Image re-encode failed (${outMime} q${attempt.quality}): ${(e as Error).message}`);
        continue;
      }
      if (best == null || encoded.bytes.length < best.bytes.length) best = encoded;
      // 达到目标即收工，但同样不能比原图更大（低质量编码的图重编码后反而变大，
      // 此时继续降质量 / 缩尺寸也压不回原图以下，交给下面的回落分支处理）。
      if (encoded.bytes.length <= targetBytes && encoded.bytes.length < input.length) {
        return new PromptImageResult(encoded.bytes, outMime, encoded.width, encoded.height, true);
      }
    }
    if (best == null) {
      throw new Error(`Failed to encode image as ${outMime}`);
    }
    if (best.bytes.length >= input.length) {
      // 极端图（小尺寸高质量 JPEG、低质量编码的大图等）压不小就别压大：
      // 保留原图，避免写侧体积反而上升。
      harnessLog('warn', `Image cannot be compressed below original (${input.length}B -> ${best.bytes.length}B), keeping original`);
      return new PromptImageResult(input, mime, srcW, srcH, false);
    }
    harnessLog('warn', `Image still above store target after ${outMime} attempts: `
      + `${input.length}B -> ${best.bytes.length}B (target ${targetBytes}B)`);
    return new PromptImageResult(best.bytes, outMime, best.width, best.height, true);
  },

  async tryCompressForStore(
    input: Buffer,
    mimeHint?: string | null,
    opts?: { thresholdBytes?: number; targetBytes?: number },
  ): Promise<PromptImageResult | undefined> {
    try {
      return await this.compressForStore(input, mimeHint, opts);
    } catch (e) {
      harnessLog('warn', `Prompt image store-compress failed: ${(e as Error).message}`);
      return undefined;
    }
  },

  /**
   * 压缩 data URI 形式的入站图片（IM 通道写入侧一次性压缩）。
   * 非 data URI、解码失败或压缩后未变小 → 原样返回，保证不影响消息入库。
   */
  async compressDataUriForStore(uri: string): Promise<string> {
    if (typeof uri !== 'string' || !uri.startsWith('data:image/')) return uri;
    const comma = uri.indexOf(',');
    if (comma < 0) return uri;
    const header = uri.slice(5, comma);
    if (!header.includes(';base64')) return uri;
    const input = Buffer.from(uri.slice(comma + 1), 'base64');
    if (input.length === 0) return uri;
    const result = await this.tryCompressForStore(input, header.split(';')[0]);
    if (result == null || result.bytes.length >= input.length) return uri;
    return result.toDataUri();
  },
};

interface StoreAttempt {
  width: number;
  height: number;
  quality: number;
}

/** 质量优先、尺寸兜底：80/70/60 各一次，再按 0.85 缩两轮。 */
function buildStoreAttempts(target: PromptSize): StoreAttempt[] {
  const attempts: StoreAttempt[] = STORE_QUALITY_STEPS.map((quality) => ({
    width: target.width, height: target.height, quality,
  }));
  let width = target.width;
  let height = target.height;
  for (let i = 0; i < STORE_SCALE_ROUNDS; i++) {
    width = Math.max(1, Math.round(width * STORE_SCALE_STEP));
    height = Math.max(1, Math.round(height * STORE_SCALE_STEP));
    attempts.push({ width, height, quality: STORE_QUALITY_STEPS[0] });
  }
  return attempts;
}

async function encodeStore(
  input: Buffer,
  attempt: StoreAttempt,
  hasAlpha: boolean,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const pipeline = sharp(input)
    .rotate()
    .resize({ width: attempt.width, height: attempt.height, fit: 'inside', withoutEnlargement: true });
  const encoded = hasAlpha
    ? await pipeline.webp({ quality: attempt.quality, effort: 4 }).toBuffer({ resolveWithObject: true })
    : await pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: attempt.quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  // 用编码后的真实尺寸回报，避免 EXIF 旋转后 width/height 与实际输出不一致。
  return { bytes: encoded.data, width: encoded.info.width, height: encoded.info.height };
}

/** EXIF 方向 5~8 表示旋转 90°/270°，宽高需要互换（sharp metadata 不解方向）。 */
function orientedDimensions(meta: sharp.Metadata): { width: number; height: number } {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const orientation = meta.orientation ?? 1;
  if (orientation >= 5 && orientation <= 8) return { width: height, height: width };
  return { width, height };
}

function encodeSpecFor(mime: string): string {
  switch (ImageFileSupport.normalizeMime(mime)) {
    case 'image/jpeg': return 'image/jpeg';
    case 'image/webp': return 'image/webp';
    default: return 'image/png';
  }
}
