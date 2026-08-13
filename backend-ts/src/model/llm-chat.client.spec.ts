import { describe, expect, it, vi } from 'vitest';
import { OpenAiChatClient } from './llm-chat.client.js';

describe('OpenAiChatClient', () => {
  it('postsToChatCompletionsWithBearerAuth', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.test/chat/completions');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-4o');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
      expect(body.stream).toBe(false);
      expect(headers['User-Agent']).toContain('codex_cli_rs');
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new OpenAiChatClient({ fetchImpl, timeoutMs: 5000 });
    const result = await client.chat(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { baseUrl: 'https://api.example.test/', apiKey: 'sk-test', modelId: 'gpt-4o' },
    );
    expect(result.choices?.[0].message?.content).toBe('ok');
  });

  it('throwsOnHttpError', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const client = new OpenAiChatClient({ fetchImpl });
    await expect(
      client.chat(
        { messages: [{ role: 'user', content: 'Hi' }] },
        { baseUrl: 'https://api.example.test', apiKey: 'sk', modelId: 'other' },
      ),
    ).rejects.toThrow(/LLM HTTP 401/);
  });
});
