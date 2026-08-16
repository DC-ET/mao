import sharp from 'sharp';
import { ImageFileSupport } from './image-file-support.js';
import { harnessLog } from '../log.js';

export const PATCH_SIZE = 32;
export const MAX_DIMENSION = 2048;
export const MAX_PATCHES = 2500;
export const JPEG_QUALITY = 0.85;

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
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    const target = this.computeTargetSize(srcW, srcH);
    if (target.width === srcW && target.height === srcH && this.fitsPromptLimits(srcW, srcH)) {
      return new PromptImageResult(input, mime, srcW, srcH, false);
    }

    const encodeMime = encodeSpecFor(mime);
    let pipeline = sharp(input).resize(target.width, target.height, { fit: 'fill' });
    let outMime = encodeMime;
    let outBytes: Buffer;
    try {
      if (encodeMime === 'image/jpeg') {
        outBytes = await pipeline.flatten({ background: { r: 0, g: 0, b: 0 } }).jpeg({ quality: Math.round(JPEG_QUALITY * 100) }).toBuffer();
      } else if (encodeMime === 'image/webp') {
        try {
          outBytes = await pipeline.webp().toBuffer();
        } catch {
          outBytes = await sharp(input).resize(target.width, target.height, { fit: 'fill' }).png().toBuffer();
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

  async tryResizeForPrompt(input: Buffer, mimeHint?: string | null): Promise<PromptImageResult | undefined> {
    try {
      return await this.resizeForPrompt(input, mimeHint);
    } catch (e) {
      harnessLog('warn', `Prompt image resize failed: ${(e as Error).message}`);
      return undefined;
    }
  },
};

function encodeSpecFor(mime: string): string {
  switch (ImageFileSupport.normalizeMime(mime)) {
    case 'image/jpeg': return 'image/jpeg';
    case 'image/webp': return 'image/webp';
    default: return 'image/png';
  }
}
