import { describe, expect, it, vi } from 'vitest';
import { imageMessageParam, fileMessageParam, limitReply, markdownMessage, sendDingtalkMarkdown } from './send.service.js';

describe('dingtalk outbound message contract', () => {
  it('sends images with sampleImageMsg photoURL set to the uploaded media id', () => {
    expect(imageMessageParam('@media-1')).toEqual({
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL: '@media-1' }),
    });
  });

  it('rejects file extensions outside the DingTalk whitelist', () => {
    expect(fileMessageParam('@m', 'notes.txt')).toEqual({ error: '钉钉文件仅支持 xlsx、pdf、zip、rar、doc、docx' });
    expect(fileMessageParam('@m', '季度报告.pdf')).toMatchObject({ msgKey: 'sampleFile' });
  });

  it('truncates markdown and retries once at 500 characters when the API says it is too long', async () => {
    expect(limitReply('你好世界啊', 4).text.endsWith('…（回复过长已截断）')).toBe(true);
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const tooLong = bodies.length === 1;
      return new Response(JSON.stringify(tooLong ? { code: 'invalidParameter', message: 'msgParam too long' } : { processQueryKey: 'ok' }), {
        status: tooLong ? 400 : 200,
      });
    });
    const result = await sendDingtalkMarkdown({
      token: async () => 'token',
      fetchImpl: fetchImpl as typeof fetch,
    }, { chatType: 'p2p', robotCode: 'r', userId: 'u' }, 'x'.repeat(800), 2000);
    expect(result).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(JSON.parse(bodies[1]).msgParam).text.length).toBeLessThanOrEqual(500);
  });

  it('puts the first line into the markdown title', () => {
    const message = markdownMessage('标题行\n正文', 2000);
    expect(JSON.parse(message.msgParam)).toMatchObject({ title: '标题行', text: '标题行\n正文' });
  });
});
