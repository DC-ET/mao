import { describe, expect, it } from 'vitest';
import { ResponsesChatClient } from './responses-chat.client.js';

describe('ResponsesChatClient', () => {
  it('拼接 output_text 并映射 usage', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1' },
          { type: 'message', content: [{ type: 'output_text', text: '你好' }] },
        ],
        usage: {
          input_tokens: 30,
          output_tokens: 6,
          total_tokens: 36,
          input_tokens_details: { cached_tokens: 24 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const client = new ResponsesChatClient({ fetchImpl });
    const result = await client.chat(
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Hi' }] },
      { baseUrl: 'https://api.example.test/v1', apiKey: 'sk', modelId: 'gpt-5' },
    );

    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(result.choices?.[0]?.message?.content).toBe('你好');
    expect(result.choices?.[0]?.finish_reason).toBe('stop');
    expect(result.usage).toEqual({
      promptTokens: 30,
      completionTokens: 6,
      totalTokens: 36,
      promptTokensDetails: { cachedTokens: 24 },
    });
  });
});
