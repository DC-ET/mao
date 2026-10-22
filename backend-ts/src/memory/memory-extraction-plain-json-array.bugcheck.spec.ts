import { describe, expect, it } from 'vitest';
import { extractStoredText } from './memory-extraction.service.js';

/**
 * 存在性证明：自动记忆抽取读取的「消息正文」不能把普通 JSON 数组文本清空。
 *
 * 抽取入口用 extractStoredText 取最后一条 USER 消息；若用户发的就是 `["a","b"]`
 * 这样的纯文本，当前实现按多模态数组解析后得到空串，随后 hasText(userText) 为 false，
 * 整轮记忆抽取被静默跳过。
 */
describe('extractStoredText 普通 JSON 数组文本', () => {
  it('字符串数组文本按原文返回', () => {
    expect(extractStoredText('["报销","流程"]')).toBe('["报销","流程"]');
  });

  it('数字数组文本按原文返回', () => {
    expect(extractStoredText('[1,2,3]')).toBe('[1,2,3]');
  });

  it('对照：真正的多模态数组抽取 text 分片', () => {
    expect(extractStoredText(JSON.stringify([
      { type: 'text', text: '图片里写了什么' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]))).toBe('图片里写了什么');
  });
});
