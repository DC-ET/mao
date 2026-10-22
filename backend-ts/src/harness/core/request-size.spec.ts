import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../llm/chat-request.js';
import { serializeChatRequest } from '../llm/json.js';
import { RequestSizeEstimator } from './request-size.js';

function textOnly(content: string): ChatRequest {
  return { messages: [{ role: 'user', content }] };
}

describe('RequestSizeEstimator', () => {
  const estimator = new RequestSizeEstimator();

  it('counts utf8 bytes for text content', () => {
    const ascii = estimator.estimate(textOnly('hello'));
    const chinese = estimator.estimate(textOnly('你好世界'));
    // 4 个汉字 = 12 字节，应明显大于 5 个 ASCII 字符
    expect(chinese).toBeGreaterThan(ascii);
    expect(chinese - ascii).toBeGreaterThan(6);
  });

  it('counts data uri length without expanding base64', () => {
    const base = 'data:image/png;base64,';
    const small = estimator.estimate({
      messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: base + 'A'.repeat(1000) } }] }],
    });
    const large = estimator.estimate({
      messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: base + 'A'.repeat(5000) } }] }],
    });
    const diff = large - small;
    expect(diff).toBeGreaterThanOrEqual(4000);
    expect(diff).toBeLessThanOrEqual(4100);
  });

  it('supports snake_case image_url parts from persisted messages', () => {
    const estimated = estimator.estimate({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${'B'.repeat(2048)}` } },
        ],
      }],
    });
    expect(estimated).toBeGreaterThan(2048);
  });

  it('stays within 5% of serializeChatRequest (deepseek, reasoning echoed)', () => {
    const request: ChatRequest = {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '帮我看看这张图' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Attached media from tool result:' },
            { type: 'image_url', imageUrl: { url: `data:image/png;base64,${'A'.repeat(6000)}` } },
          ],
        },
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'thinking about the image',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.png"}' },
          }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
      reasoning: { effort: 'max' },
      promptCacheKey: 'mao-session-1',
      stream: true,
    };
    const actual = Buffer.byteLength(
      JSON.stringify(serializeChatRequest(request, 'deepseek-chat', true)),
      'utf8',
    );
    const estimated = estimator.estimate(request, 'deepseek-chat');
    expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.05);
  });

  it('does not count reasoning content for non-deepseek models', () => {
    const request: ChatRequest = {
      messages: [{
        role: 'assistant',
        content: 'answer'.repeat(40000),
        reasoningContent: 'x'.repeat(10000),
      }],
    };
    const deepseek = estimator.estimate(request, 'deepseek-chat');
    const gpt = estimator.estimate(request, 'gpt-4o');
    expect(deepseek - gpt).toBeGreaterThan(10000);
    const actualGpt = Buffer.byteLength(
      JSON.stringify(serializeChatRequest(request, 'gpt-4o', true)),
      'utf8',
    );
    expect(Math.abs(gpt - actualGpt) / actualGpt).toBeLessThan(0.05);
  });

  it('counts remote image URLs as their expanded data URI size', () => {
    // 上传图在消息里是 URL，发送前会被适配器下载并压成 ≤1.2MB 的 data URI；
    // 只按 URL 长度计会让「150 张上传图 ≈ 45MB」的会话估算成 10KB，体积触发彻底失效。
    const estimated = estimator.estimate({
      messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: 'https://cdn.example.com/a.png' } }] }],
    });
    expect(estimated).toBeGreaterThan(1.5 * 1024 * 1024);
  });

  it('compensates JSON escaping in text-dense payloads', () => {
    const dense = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item-${i}`, nested: { ok: true, tags: ['a', 'b'] } })),
    ).repeat(20);
    const request: ChatRequest = { messages: [{ role: 'user', content: dense }, { role: 'tool', toolCallId: 'c1', content: dense }] };
    const actual = Buffer.byteLength(JSON.stringify(serializeChatRequest(request, 'gpt-4o', true)), 'utf8');
    const estimated = estimator.estimate(request, 'gpt-4o');
    // 逐字符扫描不现实，采样外推的误差目标 ≤6%（不补偿时实测低 35%）
    expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.06);
  });

  it('counts utf8 bytes for tool schemas with Chinese descriptions', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      properties[`参数${i}`] = { type: 'string', description: `订单字段说明 ${i}` };
    }
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'query',
          description: '查询订单',
          parameters: { type: 'object', properties, required: ['参数0'] },
        },
      }],
    };
    const actual = Buffer.byteLength(JSON.stringify(serializeChatRequest(request, 'gpt-4o', true)), 'utf8');
    const estimated = estimator.estimate(request, 'gpt-4o');
    expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.05);
  });

  it('is deterministic for the same request', () => {
    const request = textOnly('同一份历史');
    expect(estimator.estimate(request, 'm')).toBe(estimator.estimate(request, 'm'));
  });
});
