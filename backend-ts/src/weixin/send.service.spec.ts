import { describe, expect, it, vi } from 'vitest';
import { WEIXIN_MAX_TEXT_BYTES, sanitizeIlinkBody, splitTextForWeixin, WeixinSendService } from './send.service.js';
import type { WeixinHttpClient } from './weixin-http.js';

describe('splitTextForWeixin', () => {
  it('短文本原样返回单条', () => {
    expect(splitTextForWeixin('hello')).toEqual(['hello']);
  });

  it('空串返回空数组', () => {
    expect(splitTextForWeixin('')).toEqual([]);
  });

  it('刚好等于字节上限不切分', () => {
    const text = 'a'.repeat(WEIXIN_MAX_TEXT_BYTES);
    expect(splitTextForWeixin(text)).toEqual([text]);
  });

  it('纯中文按字节而非字符切分：2000 汉字（6000 字节）恰好不切', () => {
    const text = '中'.repeat(2000);
    expect(Buffer.byteLength(text)).toBe(6000);
    expect(splitTextForWeixin(text)).toEqual([text]);
  });

  it('中文消息每片都不超过字节上限', () => {
    const text = '中'.repeat(5000);
    const chunks = splitTextForWeixin(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(WEIXIN_MAX_TEXT_BYTES);
  });

  it('混合中英文按字节预算切分', () => {
    const para = 'x'.repeat(WEIXIN_MAX_TEXT_BYTES - 1000);
    const text = `${para}\n\n${'中'.repeat(3000)}\n\n${'y'.repeat(500)}`;
    const chunks = splitTextForWeixin(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(WEIXIN_MAX_TEXT_BYTES);
  });

  it('无分隔符时硬切，内容完整且每片不超上限', () => {
    const text = 'a'.repeat(WEIXIN_MAX_TEXT_BYTES * 2 + 37);
    const chunks = splitTextForWeixin(text);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((c) => Buffer.byteLength(c) <= WEIXIN_MAX_TEXT_BYTES)).toBe(true);
  });

  it('中文无分隔符时不会切出半个字符（拼接后与原文一致）', () => {
    const text = '中'.repeat(WEIXIN_MAX_TEXT_BYTES + 500);
    const chunks = splitTextForWeixin(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((c) => Buffer.byteLength(c) <= WEIXIN_MAX_TEXT_BYTES)).toBe(true);
    // 每片都应是完整字符序列：不含替换符，且字符数为整数个汉字
    for (const c of chunks) expect(c).not.toContain('\uFFFD');
  });

  it('分隔符落在前半段预算内才采用，避免切出过短碎片', () => {
    const text = `${'中'.repeat(1900)}\n${'b'.repeat(WEIXIN_MAX_TEXT_BYTES)}`;
    const chunks = splitTextForWeixin(text);
    expect(Buffer.byteLength(chunks[0])).toBeGreaterThan(WEIXIN_MAX_TEXT_BYTES / 2);
    expect(chunks.join('')).toBe(text);
  });
});

describe('sanitizeIlinkBody', () => {
  it('遮罩 token/secret 字段', () => {
    const masked = sanitizeIlinkBody('{"ret":-2,"bot_token":"abc123","context_token":"xyz"}');
    expect(masked).toContain('"bot_token":"***"');
    expect(masked).not.toContain('abc123');
  });

  it('空响应体标记为 empty', () => {
    expect(sanitizeIlinkBody(Buffer.alloc(0))).toBe('<empty>');
  });

  it('超长截断', () => {
    const masked = sanitizeIlinkBody('a'.repeat(1000));
    expect(masked.length).toBeLessThanOrEqual(301);
  });
});

describe('WeixinSendService', () => {
  const accountRepository = {
    findByAccountId: vi.fn(async () => ({
      accountId: 'acc-1',
      payloadJson: JSON.stringify({ token: 'tok', baseUrl: 'https://ilink.test' }),
    })),
  };
  const contextTokenRepository = { getLatestToken: vi.fn(async () => 'ctx-1') };

  it('sendTextSucceedsOnEmptyBody', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('{}'), header: () => undefined })),
    };
    const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
    expect(await service.sendText('acc-1', 'wx-1', 'hello')).toBe(true);
  });

  it('sendTextFailsWhenAccountMissing', async () => {
    const http: WeixinHttpClient = { request: vi.fn() };
    const service = new WeixinSendService(
      { findByAccountId: vi.fn(async () => null) } as never,
      contextTokenRepository as never,
      http,
    );
    expect(await service.sendText('acc-1', 'wx-1', 'hello')).toBe(false);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('sendTextFailsWhenContextTokenMissing', async () => {
    const http: WeixinHttpClient = { request: vi.fn() };
    const service = new WeixinSendService(
      accountRepository as never,
      { getLatestToken: vi.fn(async () => null) } as never,
      http,
    );
    expect(await service.sendText('acc-1', 'wx-1', 'hello')).toBe(false);
  });

  it('sendTextFailsOnBusinessError', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({
        status: 200, headers: {}, body: Buffer.from(JSON.stringify({ ret: 1, errcode: 2 })), header: () => undefined,
      })),
    };
    const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
    expect(await service.sendText('acc-1', 'wx-1', 'hello')).toBe(false);
  });

  it('sendFileAssemblesFileItem', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(''), header: () => undefined })),
    };
    const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
    const media = { encryptQueryParam: 'p', aesKey: 'k', encryptType: 1, size: 10, rawSize: 8, rawMd5: 'md5' };
    expect(await service.sendFile('acc-1', 'wx-1', media, 'a.mp3')).toBe(true);
    const body = JSON.parse(String((http.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.msg.item_list[0].type).toBe(4);
    expect(body.msg.item_list[0].file_item.file_name).toBe('a.mp3');
  });

  it('sendText 超字节上限时分片，每片独立 client_id 复用同一 context_token', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('{}'), header: () => undefined })),
    };
    const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
    // 段落边界落在字节预算内：第一段 5500 字节 + \n\n + 第二段 6000 字节 → 切成 2 片
    const long = `${'a'.repeat(5500)}\n\n${'b'.repeat(WEIXIN_MAX_TEXT_BYTES)}`;
    expect(await service.sendText('acc-1', 'wx-1', long)).toBe(true);
    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    const first = JSON.parse(String(calls[0][1].body));
    const second = JSON.parse(String(calls[1][1].body));
    expect(Buffer.byteLength(first.msg.item_list[0].text_item.text)).toBeLessThanOrEqual(WEIXIN_MAX_TEXT_BYTES);
    expect(Buffer.byteLength(second.msg.item_list[0].text_item.text)).toBeLessThanOrEqual(WEIXIN_MAX_TEXT_BYTES);
    expect(first.msg.client_id).not.toBe(second.msg.client_id);
    expect(first.msg.context_token).toBe('ctx-1');
    expect(second.msg.context_token).toBe('ctx-1');
    // 分片内容按顺序拼接后必须与原文一致（不丢字、不乱序）
    expect(first.msg.item_list[0].text_item.text + second.msg.item_list[0].text_item.text).toBe(long);
  });

  it('历史失败样本 16976 字节的长回复被切成多片且全部发送', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('{}'), header: () => undefined })),
    };
    const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
    // 复刻 2026-10-09 20:15 的失败样本：11898 字符 / 16976 字节 / 367 行 / 大量代码围栏
    const text = `${'## 标题\n```js\nconst a = 1;\n```\n'.repeat(400)}中文说明${'x'.repeat(3000)}`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(WEIXIN_MAX_TEXT_BYTES);
    expect(await service.sendText('acc-1', 'wx-1', text)).toBe(true);
    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    const sent = calls.map((c) => JSON.parse(String(c[1].body)).msg.item_list[0].text_item.text);
    expect(sent.join('')).toBe(text);
    for (const s of sent) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(WEIXIN_MAX_TEXT_BYTES);
  });

  it('sendText 分片中途失败时停止后续发送并返回 false', async () => {
    let n = 0;
    const http: WeixinHttpClient = {
      request: vi.fn(async () => {
        n += 1;
        return n === 1
          ? { status: 200, headers: {}, body: Buffer.from('{}'), header: () => undefined }
          : { status: 200, headers: {}, body: Buffer.from('{"ret":-2,"errcode":0,"errmsg":"prepare failed"}'), header: () => undefined };
      }),
    };
    const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
    const long = `${'a'.repeat(WEIXIN_MAX_TEXT_BYTES)}\n\n${'b'.repeat(WEIXIN_MAX_TEXT_BYTES)}\n\n${'c'.repeat(WEIXIN_MAX_TEXT_BYTES)}`;
    expect(await service.sendText('acc-1', 'wx-1', long)).toBe(false);
    expect((http.request as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('业务失败时把 ilink 原始响应体与 errmsg 写入错误日志', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const http: WeixinHttpClient = {
        request: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('{"ret":-2,"errmsg":"prepare failed"}'), header: () => undefined })),
      };
      const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
      expect(await service.sendText('acc-1', 'wx-1', 'hello')).toBe(false);
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('ret=-2');
      expect(logged).toContain('prepare failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('HTTP 非 2xx 时同样记录原始响应体', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const http: WeixinHttpClient = {
        request: vi.fn(async () => ({ status: 502, headers: {}, body: Buffer.from('<html>gateway error</html>'), header: () => undefined })),
      };
      const service = new WeixinSendService(accountRepository as never, contextTokenRepository as never, http);
      expect(await service.sendText('acc-1', 'wx-1', 'hello')).toBe(false);
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('HTTP 502');
      expect(logged).toContain('gateway error');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
