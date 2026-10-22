import { describe, expect, it } from 'vitest';
import { userMessagePreviewOf } from './user-message-preview.js';

/**
 * 存在性证明：普通文本恰好是 JSON 数组时，预览不能变成空串。
 *
 * 库内 content 既可能是纯文本，也可能是多模态 ContentPart 数组的 JSON。
 * 只有「每个元素都是含 type 的对象」才是多模态分片；`["a","b"]`、`[1,2]` 这类
 * 用户原样发送的文本必须按原文展示，否则任务通知里用户消息预览为空。
 */
describe('userMessagePreviewOf 普通 JSON 数组文本', () => {
  it('字符串数组文本按原文返回', () => {
    expect(userMessagePreviewOf('["任务","失败"]')).toBe('["任务","失败"]');
  });

  it('数字数组文本按原文返回', () => {
    expect(userMessagePreviewOf('[1,2,3]')).toBe('[1,2,3]');
  });

  it('对照：真正的多模态数组仍抽取文本与图片占位', () => {
    expect(userMessagePreviewOf(JSON.stringify([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]))).toBe('看看这张图\n[图片]×1');
  });
});
