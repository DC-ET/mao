import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PromptImageResizer, PROMPT_SAFE_MIMES } from './prompt-image-resizer.js';
import { ImageFileSupport } from './image-file-support.js';

/**
 * Bugcheck：非 prompt 安全格式（TIFF/BMP 等）被原样透传给上游。
 *
 * 背景（2026-11-09 会话 2368）：用户上传的截图文件名形如 `xxx.tiff.jpg`，实际是 TIFF
 * （Content-Type: image/tiff，834×172，433KB）。resizeForPrompt 只按「尺寸/体积是否超限」
 * 决定是否重编码——TIFF 尺寸合规，于是原始 TIFF 字节被原样转成
 * `data:image/tiff;base64,...` 发给模型；上游 newapi 的 kuaishou 渠道只认
 * webp/png/jpeg/gif，随机路由到不支持 TIFF 的渠道时直接 400 `unsupported image`。
 *
 * 修复：增加 PROMPT_SAFE_MIMES 白名单，非安全格式即使尺寸/体积合规也强制转码为 PNG。
 */

async function makeTiff(width = 120, height = 60): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).tiff().toBuffer();
}

describe('非 prompt 安全格式转码', () => {
  it('resizeForPrompt 把尺寸合规的 TIFF 转成 PNG（而非原样透传）', async () => {
    const tiff = await makeTiff();
    expect(ImageFileSupport.detectMimeFromBytes(tiff)).toBeUndefined();

    const result = await PromptImageResizer.resizeForPrompt(tiff, 'image/tiff');
    expect(result.resized).toBe(true);
    expect(result.mime).toBe('image/png');
    expect(ImageFileSupport.detectMimeFromBytes(result.bytes)).toBe('image/png');
    expect(result.width).toBe(120);
    expect(result.height).toBe(60);
    expect(result.toDataUri()).toMatch(/^data:image\/png;base64,/);
  });

  it('compressForStore 对 TIFF 的产物必定是 prompt 安全格式', async () => {
    const tiff = await makeTiff(800, 200);
    const result = await PromptImageResizer.compressForStore(tiff, 'image/tiff');
    expect(PROMPT_SAFE_MIMES.has(result.mime)).toBe(true);
    expect(ImageFileSupport.detectMimeFromBytes(result.bytes)).toBe(result.mime);
    expect(result.toDataUri()).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
  });

  it('尺寸合规的安全格式仍然原样返回（不重编码、不破坏前缀缓存）', async () => {
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toBuffer();
    const tiffGif = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 255, b: 0 } },
    }).gif().toBuffer();

    for (const [bytes, mime] of [[png, 'image/png'], [tiffGif, 'image/gif']] as const) {
      const result = await PromptImageResizer.resizeForPrompt(bytes, mime);
      expect(result.resized).toBe(false);
      expect(result.mime).toBe(mime);
      expect(result.bytes.equals(bytes)).toBe(true);
    }
  });
});
