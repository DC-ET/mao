import { describe, expect, it } from 'vitest';
import { PromptImageResizer, MAX_DIMENSION } from './prompt-image-resizer.js';
import { ImageFileSupport } from './image-file-support.js';
import { ToolImageResultProcessor } from './tool-image-result-processor.js';
import { ToolAttachmentLoader } from '../core/tool-attachment-loader.js';
import sharp from 'sharp';

describe('PromptImageResizer', () => {
  it('computeTargetSizeShrinks2048SquareTo1600ForPatchBudget', () => {
    const size = PromptImageResizer.computeTargetSize(2048, 2048);
    expect(size.width).toBe(1600);
    expect(size.height).toBe(1600);
    expect(PromptImageResizer.fitsPromptLimits(1600, 1600)).toBe(true);
  });

  it('computeTargetSizeLeavesSmallImagesUnchanged', () => {
    const size = PromptImageResizer.computeTargetSize(32, 24);
    expect(size).toEqual({ width: 32, height: 24 });
    expect(PromptImageResizer.fitsPromptLimits(32, 24)).toBe(true);
  });

  it('computeTargetSizeFirstCapsLongestEdgeThenPatches', () => {
    const size = PromptImageResizer.computeTargetSize(4096, 2048);
    expect(size.width).toBe(2048);
    expect(size.height).toBe(1024);
    expect(PromptImageResizer.fitsPromptLimits(size.width, size.height)).toBe(true);
  });

  it('computeTargetSizeCapsOversizedSquareViaDimensionThenPatches', () => {
    const size = PromptImageResizer.computeTargetSize(4000, 4000);
    expect(size.width).toBe(1600);
    expect(size.height).toBe(1600);
  });

  it('resizeForPromptIsNoOpForSmallPng', async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    const result = await PromptImageResizer.resizeForPrompt(png, 'image/png');
    expect(result.resized).toBe(false);
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.bytes.equals(png)).toBe(true);
    expect(result.mime).toBe('image/png');
  });

  it('resizeForPromptShrinksLargePng', async () => {
    const png = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    const result = await PromptImageResizer.resizeForPrompt(png, 'image/png');
    expect(result.resized).toBe(true);
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1600);
    expect(result.mime).toBe('image/png');
    expect(result.bytes.length).toBeLessThan(png.length);
    expect(result.toDataUri()).toMatch(/^data:image\/png;base64,/);
  });

  it('resizeForPromptReencodesJpegAtQuality85WhenResized', async () => {
    const jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 0, g: 255, b: 0 } } }).jpeg().toBuffer();
    const result = await PromptImageResizer.resizeForPrompt(jpeg, 'image/jpeg');
    expect(result.resized).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(result.width).toBeLessThanOrEqual(MAX_DIMENSION);
    expect(result.height).toBeLessThanOrEqual(MAX_DIMENSION);
    expect(PromptImageResizer.fitsPromptLimits(result.width, result.height)).toBe(true);
    expect(ImageFileSupport.detectMimeFromBytes(result.bytes)).toContain('image/jpeg');
  });
});

describe('ImageFileSupport', () => {
  it('resolveImageMimePrefersMagicBytesOverOctetStream', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ImageFileSupport.resolveImageMime(jpeg, 'application/octet-stream', '/uploads/no-ext')).toContain('image/jpeg');
  });

  it('extensionForMimeAndNormalizeMime', () => {
    expect(ImageFileSupport.extensionForMime('image/png')).toBe('.png');
    expect(ImageFileSupport.normalizeMime('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(ImageFileSupport.isImageMime('application/octet-stream')).toBe(false);
  });
});

describe('ToolImageResultProcessor', () => {
  it('stripsDataUriAndBuildsMetadataWhenVisionSupported', () => {
    const raw = '{"content":"图片读取成功","total_lines":0,"media_type":"image","mime":"image/png","path":"a.png","data_uri":"data:image/png;base64,abc"}';
    const processed = ToolImageResultProcessor.process(raw, true);
    expect(processed.sanitizedContent).not.toContain('data_uri');
    expect(processed.attachment?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(processed.metadataJson).toContain('attachments');
    expect(processed.preview).toMatchObject({ media_type: 'image' });
  });

  it('returnsVisionErrorWithoutAttachmentWhenUnsupported', () => {
    const raw = '{"content":"图片读取成功","total_lines":0,"media_type":"image","mime":"image/png","path":"a.png","data_uri":"data:image/png;base64,abc"}';
    const processed = ToolImageResultProcessor.process(raw, false);
    expect(processed.sanitizedContent).toContain('不支持图片输入');
    expect(processed.attachment).toBeNull();
    expect(processed.metadataJson).toBeNull();
  });

  it('returnsPlainTextToolResultUnchangedWithoutWarningPath', () => {
    const raw = 'exit_code: 0\nstdout:\nok\n';
    const processed = ToolImageResultProcessor.process(raw, true);
    expect(processed.sanitizedContent).toBe(raw);
    expect(processed.attachment).toBeNull();
    expect(processed.metadataJson).toBeNull();
    expect(processed.preview).toBeNull();
  });

  it('loadsAttachmentFromMessageMetadata', () => {
    const message = {
      role: 'TOOL',
      toolCallId: 'call-1',
      metadata: '{"attachments":[{"mime":"image/png","path":"a.png","data_uri":"data:image/png;base64,xyz"}]}',
    };
    const loaded = ToolAttachmentLoader.loadAllFromMessages([message]);
    expect(loaded['call-1'].dataUri).toContain('xyz');
  });
});
