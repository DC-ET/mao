import { describe, expect, it, vi } from 'vitest';
import { RecordingLlmChatClient } from './recording-llm-chat-client.js';

const USAGE = { promptTokens: 100, completionTokens: 8, totalTokens: 108 };

function pricedConfig() {
  return {
    id: 3,
    baseUrl: 'https://llm.example.com',
    apiKey: 'sk',
    modelId: 'gpt-test',
    priceInput: 2,
    priceOutput: 8,
  };
}

describe('RecordingLlmChatClient', () => {
  it('非流式调用落库 usage 并按真实 token 计价', async () => {
    const record = vi.fn(async () => undefined);
    const delegate = { chat: vi.fn(async () => ({ choices: [], usage: USAGE })) };
    const client = new RecordingLlmChatClient(delegate as never, { record } as never);

    const response = await client.chat({ messages: [] }, pricedConfig());

    expect(response.usage).toEqual(USAGE);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      usage: USAGE,
      stream: false,
      success: true,
      // 100 × 2 + 8 × 8 = 264（成本微单位）
      costMicros: 264,
    }));
  });

  it('响应缺 usage 时按 null 落库，不把调用记成 0 token', async () => {
    const record = vi.fn(async () => undefined);
    const delegate = { chat: vi.fn(async () => ({ choices: [] })) };
    const client = new RecordingLlmChatClient(delegate as never, { record } as never);

    await client.chat({ messages: [] }, pricedConfig());

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ usage: null }));
  });

  it('调用失败时记录错误与空 usage', async () => {
    const record = vi.fn(async () => undefined);
    const delegate = { chat: vi.fn(async () => { throw new Error('boom'); }) };
    const client = new RecordingLlmChatClient(delegate as never, { record } as never);

    await expect(client.chat({ messages: [] }, pricedConfig())).rejects.toThrow('boom');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      usage: null,
      success: false,
      errorMessage: 'boom',
    }));
  });
});
