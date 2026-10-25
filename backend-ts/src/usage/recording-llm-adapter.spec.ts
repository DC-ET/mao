import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse, ChatUsage, LlmAdapter, StreamCallback } from '../harness/llm/chat-request.js';
import { RecordingLlmAdapter, captureSystemPrompt, captureToolNames, SYSTEM_PROMPT_CAPTURE_MAX_CHARS } from './recording-llm-adapter.js';
import type { LlmCallService } from './llm-call.service.js';
import { LLM_CALL_SCENES, LlmCallContext } from './llm-call-context.js';

function usage(): ChatUsage {
  return { promptTokens: 10, completionTokens: 5, totalTokens: 15, promptTokensDetails: { cachedTokens: 2 } };
}

describe('RecordingLlmAdapter', () => {
  it('records successful chat calls', async () => {
    const delegate: LlmAdapter = {
      chat: vi.fn(async () => ({ usage: usage() } as ChatResponse)),
      stream: vi.fn(),
    };
    const record = vi.fn(async () => {});
    const adapter = new RecordingLlmAdapter(delegate, { record } as unknown as LlmCallService);
    await LlmCallContext.runAsync({ scene: LLM_CALL_SCENES.AGENT, userId: 1, sessionId: 2, agentId: 3 }, async () => {
      await adapter.chat({ messages: [] }, { id: 9, modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k' });
    });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      stream: false,
      success: true,
      usage: usage(),
      retryCount: 0,
    });
  });

  it('records failed chat without throwing from recorder', async () => {
    const delegate: LlmAdapter = {
      chat: vi.fn(async () => { throw new Error('boom'); }),
      stream: vi.fn(),
    };
    const record = vi.fn(async () => {});
    const adapter = new RecordingLlmAdapter(delegate, { record } as unknown as LlmCallService);
    await expect(adapter.chat({ messages: [] }, { id: 9, modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k' }))
      .rejects.toThrow('boom');
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({ success: false, errorMessage: 'boom' });
  });

  it('keeps usage that arrived before a stream error', async () => {
    const partial: ChatUsage = {
      promptTokens: 1200, completionTokens: 200, totalTokens: 1400,
      promptTokensDetails: { cachedTokens: 400, cacheCreationTokens: 200 },
    };
    const delegate: LlmAdapter = {
      chat: vi.fn(),
      stream: vi.fn(async (_req, _cfg, callback: StreamCallback) => {
        callback.onUsage?.(partial);
        callback.onError(new Error('模型流式响应已中断，自动重试已耗尽'));
      }),
    };
    const record = vi.fn(async () => {});
    const adapter = new RecordingLlmAdapter(delegate, { record } as unknown as LlmCallService);
    await adapter.stream({ messages: [] }, {
      id: 1, modelId: 'm', baseUrl: 'http://x', apiKey: 'k',
      priceInput: 2, priceCacheRead: 1, priceCacheWrite: 2, priceOutput: 8,
    }, { onChunk: () => {}, onComplete: () => {}, onError: () => {} });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      success: false,
      usage: partial,
      costMicros: 3600,
    });
  });

  it('records stream first token timing', async () => {
    const delegate: LlmAdapter = {
      chat: vi.fn(),
      stream: vi.fn(async (_req, _cfg, callback: StreamCallback) => {
        callback.onChunk({ choices: [{ delta: { content: 'hi' } }] });
        callback.onComplete(usage());
      }),
    };
    const record = vi.fn(async () => {});
    const adapter = new RecordingLlmAdapter(delegate, { record } as unknown as LlmCallService);
    await adapter.stream({ messages: [] }, { id: 9, modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k' }, {
      onChunk: () => {},
      onComplete: () => {},
      onError: () => {},
    });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0].firstTokenMs).toBeTypeOf('number');
    expect(record.mock.calls[0][0].success).toBe(true);
  });
});

describe('请求构成采集（技术方案 2026-10-25-run-trace-content-and-prompt §5.2）', () => {
  const config = { id: 9, modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k' };

  function makeAdapter(record: ReturnType<typeof vi.fn>) {
    const delegate: LlmAdapter = {
      chat: vi.fn(async () => ({ usage: usage() } as ChatResponse)),
      stream: vi.fn(),
    };
    return new RecordingLlmAdapter(delegate, { record } as unknown as LlmCallService);
  }

  it('chat 把 system 消息全文与工具名清单透传给 record', async () => {
    const record = vi.fn(async () => {});
    const adapter = makeAdapter(record);
    await adapter.chat({
      messages: [
        { role: 'system', content: '你是运维助手' },
        { role: 'system', content: '环境：生产' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: {} } },
        { type: 'function', function: { name: 'shell', parameters: {} } },
      ],
    }, config);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      systemPrompt: '你是运维助手\n\n环境：生产',
      toolsJson: '["read_file","shell"]',
    });
  });

  it('stream 同样透传采集结果（顺序保持 request.tools 原序）', async () => {
    const record = vi.fn(async () => {});
    const adapter = makeAdapter(record);
    await adapter.stream({
      messages: [{ role: 'system', content: '压缩指令' }],
      tools: [{ type: 'function', function: { name: 'b_tool' } }, { type: 'function', function: { name: 'a_tool' } }],
    }, config, { onChunk: () => {}, onComplete: () => {}, onError: () => {} });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      stream: true,
      systemPrompt: '压缩指令',
      toolsJson: '["b_tool","a_tool"]',
    });
  });

  it('无 system 消息 / 无工具时透传 null，不伪造空串', async () => {
    const record = vi.fn(async () => {});
    const adapter = makeAdapter(record);
    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }, config);
    expect(record.mock.calls[0]![0].systemPrompt).toBeNull();
    expect(record.mock.calls[0]![0].toolsJson).toBeNull();
  });

  it('多 system 消息只取 role=system；非字符串内容 JSON 序列化兜底', () => {
    expect(captureSystemPrompt({ messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 's1' }] }))
      .toBe('s1');
    expect(captureSystemPrompt({ messages: [{ role: 'system', content: { a: 1 } }] }))
      .toBe('{"a":1}');
  });

  it('超过采集上限时截断并带原长标记', () => {
    const long = 'x'.repeat(SYSTEM_PROMPT_CAPTURE_MAX_CHARS + 10_000);
    const captured = captureSystemPrompt({ messages: [{ role: 'system', content: long }] });
    expect(captured).toBeTruthy();
    expect(captured!.startsWith('x'.repeat(100))).toBe(true);
    expect(captured).toMatch(/…\[已截断，原长 272144 字符\]$/);
    expect(captured!.length).toBeLessThan(long.length);
  });

  it('工具缺 function / 缺 name 的条目跳过；全跳过时为 null；tools 缺省为 null', () => {
    expect(captureToolNames({
      tools: [
        { type: 'function', function: { name: 'a' } },
        { type: 'function' },
        { function: { name: '' } },
      ],
    } as never)).toBe('["a"]');
    expect(captureToolNames({ tools: [{ type: 'function' }] } as never)).toBeNull();
    expect(captureToolNames({})).toBeNull();
  });
});
