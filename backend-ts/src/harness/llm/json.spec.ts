import { describe, expect, it } from 'vitest';
import type { ChatRequest } from './chat-request.js';
import { serializeChatRequest } from './json.js';

describe('serializeChatRequest', () => {
  it.each([false, true])('omits internal tool summaries without mutating history (stream=%s)', (stream) => {
    const toolCalls = [
      {
        id: 'call_date',
        type: 'function',
        function: { name: 'shell', arguments: '{"command":"date"}' },
        summary: '执行 date (2 行输出)',
      },
      {
        id: 'call_read',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        summary: '',
      },
    ];
    const request: ChatRequest = {
      messages: [
        { role: 'system', content: '网页助手' },
        { role: 'user', content: '现在几点' },
        { role: 'assistant', content: '', toolCalls },
        { role: 'tool', content: '2026-09-08 09:29:00 CST', toolCallId: 'call_date' },
        { role: 'tool', content: '文档正文', toolCallId: 'call_read' },
      ],
    };
    const original = structuredClone(request);

    const body = serializeChatRequest(request, 'glm-5.3', stream);

    expect(body).toEqual({
      model: 'glm-5.3',
      stream,
      messages: [
        { role: 'system', content: '网页助手' },
        { role: 'user', content: '现在几点' },
        {
          role: 'assistant', content: '',
          tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: tc.type, function: tc.function })),
        },
        { role: 'tool', content: '2026-09-08 09:29:00 CST', tool_call_id: 'call_date' },
        { role: 'tool', content: '文档正文', tool_call_id: 'call_read' },
      ],
    });
    expect(request).toEqual(original);
  });

  it.each([
    ['deepseek-chat', true],
    ['DeepSeek-Reasoner', true],
    ['ds-v4-flash', true],
    ['glm-5.3', false],
    ['gpt-test', false],
  ])('echoes reasoning_content only for DeepSeek-family models (model=%s)', (modelId, expected) => {
    const request: ChatRequest = {
      messages: [
        { role: 'assistant', content: '', reasoningContent: '思考过程', toolCalls: [] },
        { role: 'tool', content: '结果', toolCallId: 'call_1' },
      ],
    };
    const body = serializeChatRequest(request, modelId, false);
    const assistant = (body.messages as Record<string, unknown>[])[0];
    if (expected) {
      expect(assistant.reasoning_content).toBe('思考过程');
    } else {
      expect(assistant).not.toHaveProperty('reasoning_content');
    }
  });
});
