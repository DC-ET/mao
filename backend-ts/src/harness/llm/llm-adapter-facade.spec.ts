import { describe, expect, it } from 'vitest';
import { LlmAdapterFacade } from './llm-adapter-facade.js';
import type { ChatRequest, ChatResponse, LlmAdapter, LlmModelConfig, StreamCallback } from './chat-request.js';

function fakeAdapter(tag: string): LlmAdapter {
  return {
    chat: async (): Promise<ChatResponse> => ({ id: tag, choices: [] }),
    stream: async (): Promise<void> => {},
  };
}

function config(provider?: string | null): LlmModelConfig {
  return { baseUrl: 'https://api.example.test', apiKey: 'key', modelId: 'm', provider } as LlmModelConfig;
}

describe('LlmAdapterFacade', () => {
  const openai = fakeAdapter('openai');
  const anthropic = fakeAdapter('anthropic');
  const facade = new LlmAdapterFacade(new Map([['anthropic', anthropic]]), openai);

  it('按 provider 精确路由', async () => {
    await expect(facade.chat({ messages: [] }, config('anthropic'))).resolves.toMatchObject({ id: 'anthropic' });
    await expect(facade.chat({ messages: [] }, config('openai-compatible'))).resolves.toMatchObject({ id: 'openai' });
  });

  it('大小写与首尾空白归一后路由', async () => {
    await expect(facade.chat({ messages: [] }, config(' Anthropic '))).resolves.toMatchObject({ id: 'anthropic' });
    await expect(facade.chat({ messages: [] }, config('ANTHROPIC'))).resolves.toMatchObject({ id: 'anthropic' });
  });

  it('未知与空 provider 回落默认实现', async () => {
    await expect(facade.chat({ messages: [] }, config('gemini'))).resolves.toMatchObject({ id: 'openai' });
    await expect(facade.chat({ messages: [] }, config(null))).resolves.toMatchObject({ id: 'openai' });
    await expect(facade.chat({ messages: [] }, config(undefined))).resolves.toMatchObject({ id: 'openai' });
    await expect(facade.chat({ messages: [] }, config('  '))).resolves.toMatchObject({ id: 'openai' });
  });

  it('stream 透传相同路由', async () => {
    const callback: StreamCallback = {
      onChunk: () => {},
      onComplete: () => {},
      onError: () => {},
    };
    const seen: string[] = [];
    const recording = new LlmAdapterFacade(
      new Map([['anthropic', {
        chat: async () => ({ choices: [] }),
        stream: async () => { seen.push('anthropic'); },
      }]]),
      {
        chat: async () => ({ choices: [] }),
        stream: async () => { seen.push('openai'); },
      },
    );
    await recording.stream({ messages: [] } as ChatRequest, config('anthropic'), callback);
    await recording.stream({ messages: [] } as ChatRequest, config(undefined), callback);
    expect(seen).toEqual(['anthropic', 'openai']);
  });
});
