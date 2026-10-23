import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../llm/chat-request.js';
import { serializeChatRequest } from '../llm/json.js';
import { RequestSizeEstimator } from './request-size.js';

/**
 * Bugcheck：RequestSizeEstimator 与真实序列化器的偏差。
 *
 * 背景（2026-10-22 fa3f47b1）：体积触发阈值按估算字节判断，估算显著低估会让
 * 阈值失效（413 后才触发压缩）；显著高估会让压缩过早触发、白烧 token。
 */

function actualBytes(request: ChatRequest, modelId = 'gpt-4o'): number {
  return Buffer.byteLength(JSON.stringify(serializeChatRequest(request, modelId, true)), 'utf8');
}

describe('RequestSizeEstimator accuracy', () => {
  const estimator = new RequestSizeEstimator();

  it('handles a message whose content is a bare string with control characters', () => {
    // 控制字符在 JSON 里膨胀为 \u00XX（6 字符），采样补偿是否覆盖
    const dense = '\u0001\u0002\u0003'.repeat(5000);
    const request: ChatRequest = { messages: [{ role: 'user', content: dense }] };
    const ratio = Math.abs(estimator.estimate(request) - actualBytes(request)) / actualBytes(request);
    expect(ratio).toBeLessThan(0.1);
  });

  it('handles multi-byte characters at the sampling boundary', () => {
    // 首/中/尾各采样 32K 字符；把多字节字符卡在段边界上
    const text = 'x'.repeat(32 * 1024 - 2) + '😀' + 'y'.repeat(64 * 1024) + '😀' + 'z'.repeat(32 * 1024);
    const request: ChatRequest = { messages: [{ role: 'user', content: text }] };
    const ratio = Math.abs(estimator.estimate(request) - actualBytes(request)) / actualBytes(request);
    expect(ratio).toBeLessThan(0.05);
  });

  it('counts a tool message with a large JSON result', () => {
    const result = JSON.stringify({ files: Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.ts`, size: i })) });
    const request: ChatRequest = {
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list', arguments: '{}' } }] },
        { role: 'tool', toolCallId: 'c1', content: result },
      ],
    };
    const ratio = Math.abs(estimator.estimate(request) - actualBytes(request)) / actualBytes(request);
    expect(ratio).toBeLessThan(0.06);
  });

  it('handles a message with both camelCase and snake_case image parts', () => {
    // 落库用 snake_case，内存对象用 camelCase；一条消息里混有两者时都要计入
    const request: ChatRequest = {
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(3000) } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'B'.repeat(3000) } },
        ],
      }],
    };
    expect(estimator.estimate(request)).toBeGreaterThan(6000);
    const ratio = Math.abs(estimator.estimate(request) - actualBytes(request)) / actualBytes(request);
    expect(ratio).toBeLessThan(0.1);
  });

  it('does not count non-image content parts twice', () => {
    const request: ChatRequest = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'a'.repeat(1000) },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(1000) } },
          { type: 'text', text: 'b'.repeat(1000) },
        ],
      }],
    };
    const ratio = Math.abs(estimator.estimate(request) - actualBytes(request)) / actualBytes(request);
    expect(ratio).toBeLessThan(0.1);
  });

  it('handles an empty messages array and undefined tools', () => {
    const request: ChatRequest = { messages: [] };
    const est = estimator.estimate(request);
    const act = actualBytes(request);
    // 极小 body 下固定开销占比高（TOP_LEVEL_OVERHEAD=160 vs 实际约 46 字节），
    // 高估约 118 字节；对 40MB 阈值无实际影响，只要求不崩且为有限正数
    expect(Number.isFinite(est)).toBe(true);
    expect(est).toBeGreaterThan(0);
    expect(est - act).toBeLessThan(200);
  });

  it('stays accurate when the same tools array is reused across calls', () => {
    const tools = [{
      type: 'function',
      function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    }];
    const request: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools };
    const first = estimator.estimate(request);
    const second = estimator.estimate(request);
    expect(first).toBe(second);
    // 绝对值很小，只要求在合理范围内且不低估
    const act = actualBytes(request);
    expect(first).toBeGreaterThan(act);
    expect(first).toBeLessThan(act * 1.6);
  });

  it('handles circular-safe tool parameters (JSON.stringify throws)', () => {
    // parameters 带循环引用时 JSON.stringify 抛错，估算必须走兜底而不是崩掉
    const circular: Record<string, unknown> = { type: 'object' };
    circular.self = circular;
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'x', description: 'd', parameters: circular } }],
    };
    expect(() => estimator.estimate(request)).not.toThrow();
    expect(estimator.estimate(request)).toBeGreaterThan(0);
  });
});
