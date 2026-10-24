import { describe, expect, it } from 'vitest';
import { ToolImageResultProcessor } from './tool-image-result-processor.js';
import { normalizeToolResult } from './tool-result.js';

/**
 * 「当前模型不支持图片输入」是读文件失败，不是成功。
 *
 * ToolImageResultProcessor 把结果替换成 {"content":"错误：…","total_lines":0}，
 * 但没有 error 键；normalizeToolResult 以「JSON 顶层含 error 键」判定失败态
 * （read-file-tool.ts readError 的注释即此口径），于是这条结果被判成功，
 * 前端工具卡、审计与统计都把读图失败记成成功。
 */
const IMAGE_RESULT = JSON.stringify({
  media_type: 'image',
  mime: 'image/png',
  path: 'shot.png',
  size_bytes: 1024,
  data_uri: 'data:image/png;base64,AAAA',
});

describe('不支持视觉时图片读取失败必须带 error 键', () => {
  it('sanitizedContent 顶层应含 error（当前只有 content/total_lines）', () => {
    const processed = ToolImageResultProcessor.process(IMAGE_RESULT, false);
    const out = JSON.parse(String(processed.sanitizedContent)) as Record<string, unknown>;
    expect(out.error).toBeDefined();
    expect(String(out.error)).toContain('不支持图片输入');
  });

  it('下游 normalizeToolResult 必须判为 error（当前判 success）', () => {
    const processed = ToolImageResultProcessor.process(IMAGE_RESULT, false);
    const normalized = normalizeToolResult('call-1', String(processed.sanitizedContent));
    expect(normalized.status).toBe('error');
    expect(normalized.errorMessage).toContain('不支持图片输入');
  });

  it('对照：支持视觉时正常剥离 data_uri 并产出附件，状态成功', () => {
    const processed = ToolImageResultProcessor.process(IMAGE_RESULT, true);
    const normalized = normalizeToolResult('call-2', String(processed.sanitizedContent));
    expect(normalized.status).toBe('success');
    expect(processed.attachment?.mime).toBe('image/png');
    expect(String(processed.sanitizedContent)).not.toContain('data:image');
  });
});
