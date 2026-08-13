import { describe, expect, it, vi } from 'vitest';
import { WeixinSendService } from './send.service.js';
import type { WeixinHttpClient } from './weixin-http.js';

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
});
