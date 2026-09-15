import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse, ChatUsage, LlmAdapter, StreamCallback } from '../harness/llm/chat-request.js';
import { RecordingLlmAdapter } from './recording-llm-adapter.js';
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
