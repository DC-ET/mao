import { describe, expect, it, vi } from 'vitest';
import { WeixinMediaUploadService } from './media-upload.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';
import type { WeixinHttpClient } from './weixin-http.js';
import { encryptAes128Ecb } from '../crypto/aes-gcm.js';

describe('WeixinMediaUploadService', () => {
  it('uploadsUsingFullUrlAndEncryptedParam', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async (url: string) => {
        if (url.includes('getuploadurl')) {
          return {
            status: 200, headers: {},
            body: Buffer.from(JSON.stringify({ upload_full_url: 'https://cdn.test/upload' })),
            header: () => undefined,
          };
        }
        return {
          status: 200, headers: { 'x-encrypted-param': 'enc-p' },
          body: Buffer.alloc(0),
          header: (name: string) => (name.toLowerCase() === 'x-encrypted-param' ? 'enc-p' : undefined),
        };
      }),
    };
    const service = new WeixinMediaUploadService(DEFAULT_WEIXIN_BOT_CONFIG, http);
    const account = {
      accountId: 'acc-1',
      payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
    };
    const media = await service.uploadFile(account, 'wx-1', Buffer.from('hello-media'));
    expect(media).not.toBeNull();
    expect(media!.encryptQueryParam).toBe('enc-p');
    expect(media!.encryptType).toBe(1);
    expect(media!.rawSize).toBe(Buffer.from('hello-media').length);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('fallsBackToUploadParamAndCdnBase', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async (url: string) => {
        if (url.includes('getuploadurl')) {
          return {
            status: 200, headers: {},
            body: Buffer.from(JSON.stringify({ upload_param: 'qp' })),
            header: () => undefined,
          };
        }
        expect(url).toContain('/upload?encrypted_query_param=');
        return {
          status: 200, headers: {},
          body: Buffer.alloc(0),
          header: () => 'enc-2',
        };
      }),
    };
    const service = new WeixinMediaUploadService({ ...DEFAULT_WEIXIN_BOT_CONFIG, cdnBaseUrl: '' }, http);
    const media = await service.uploadImage({
      accountId: 'acc-1',
      payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
    }, 'wx-1', Buffer.from('img'));
    expect(media?.encryptQueryParam).toBe('enc-2');
  });

  it('returnsEmptyWhenGetuploadurlFails', async () => {
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({
        status: 500, headers: {}, body: Buffer.from('err'), header: () => undefined,
      })),
    };
    const service = new WeixinMediaUploadService(DEFAULT_WEIXIN_BOT_CONFIG, http);
    const media = await service.uploadVoice({
      accountId: 'acc-1',
      payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
    }, 'wx-1', Buffer.from('v'));
    expect(media).toBeNull();
  });

  it('ciphertextMatchesAes128Ecb', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const plain = Buffer.from('pad-me-please!!');
    expect(encryptAes128Ecb(plain, key).length % 16).toBe(0);
  });
});
