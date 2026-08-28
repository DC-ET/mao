import { describe, expect, it, vi } from 'vitest';
import { GroupContextSummarizer } from './group-context-summarizer.js';

function makeResponse(text: unknown) {
  return { choices: [{ message: { content: text } }] };
}

const MODEL_CONFIG = { baseUrl: 'https://llm.example.com', apiKey: 'sk', modelId: 'gpt-test' };

describe('GroupContextSummarizer', () => {
  it('summarizes via the session model config and trims the output', async () => {
    const chat = vi.fn(async () => makeResponse('  摘要内容  '));
    const resolveModelConfig = vi.fn(async (sessionId: number) => {
      expect(sessionId).toBe(9);
      return MODEL_CONFIG;
    });
    const summarizer = new GroupContextSummarizer({ chat } as never, resolveModelConfig);
    const summary = await summarizer.summarize('[2026-08-26 09:00] 张三：讨论1', 9);
    expect(summary).toBe('摘要内容');
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      stream: false,
      temperature: 0.2,
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: '[2026-08-26 09:00] 张三：讨论1' },
      ],
    }), MODEL_CONFIG);
  });

  it('extracts text from content-part arrays', async () => {
    const chat = vi.fn(async () => makeResponse([{ type: 'text', text: '分段' }, { type: 'text', text: '摘要' }]));
    const summarizer = new GroupContextSummarizer({ chat } as never, async () => MODEL_CONFIG);
    expect(await summarizer.summarize('记录')).toBe('分段摘要');
  });

  it('returns null when no model is available', async () => {
    const chat = vi.fn();
    const summarizer = new GroupContextSummarizer({ chat } as never, async () => null);
    expect(await summarizer.summarize('记录', 9)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when model resolution fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chat = vi.fn();
    const summarizer = new GroupContextSummarizer({ chat } as never, async () => { throw new Error('model gone'); });
    expect(await summarizer.summarize('记录', 9)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null instead of throwing when the LLM call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chat = vi.fn(async () => { throw new Error('boom'); });
    const summarizer = new GroupContextSummarizer({ chat } as never, async () => MODEL_CONFIG);
    expect(await summarizer.summarize('记录', 9)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('群聊溢出消息摘要失败'));
    warn.mockRestore();
  });

  it('returns null for empty records or empty model output', async () => {
    const chat = vi.fn(async () => makeResponse('   '));
    const summarizer = new GroupContextSummarizer({ chat } as never, async () => MODEL_CONFIG);
    expect(await summarizer.summarize('  ', 9)).toBeNull();
    expect(await summarizer.summarize('记录', 9)).toBeNull();
  });
});
