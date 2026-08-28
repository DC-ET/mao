import { describe, expect, it } from 'vitest';
import { AnthropicChatClient } from './anthropic-chat.client.js';

function fetchOk(body: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('AnthropicChatClient', () => {
  it('POST {baseUrl}/messages，system 拆顶层、双认证头、max_tokens', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        id: 'msg_1',
        content: [{ type: 'text', text: '你好' }],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const client = new AnthropicChatClient({ fetchImpl, timeoutMs: 5000 });
    const result = await client.chat(
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Hi' }] },
      { baseUrl: 'https://api.example.test/v1/', apiKey: 'sk-ant', modelId: 'claude-test' },
    );

    expect(capturedUrl).toBe('https://api.example.test/v1/messages');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers.Authorization).toBe('Bearer sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body.model).toBe('claude-test');
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);

    expect(result.choices?.[0]?.message?.content).toBe('你好');
    expect(result.choices?.[0]?.finish_reason).toBe('stop');
  });

  it('HTTP 错误时抛出含状态码的异常', async () => {
    const fetchImpl = (async () => new Response('{"type":"error","error":{"type":"authentication_error"}}', {
      status: 401,
    })) as unknown as typeof fetch;
    const client = new AnthropicChatClient({ fetchImpl });
    await expect(client.chat(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { baseUrl: 'https://api.example.test', apiKey: 'bad', modelId: 'claude-test' },
    )).rejects.toThrow(/401/);
  });

  it('首个 text block 内容拼接返回', async () => {
    const client = new AnthropicChatClient({
      fetchImpl: fetchOk({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    });
    const result = await client.chat(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { baseUrl: 'https://api.example.test', apiKey: 'k', modelId: 'm' },
    );
    expect(result.choices?.[0]?.message?.content).toBe('ab');
  });
});
