import { createHash, randomBytes } from 'node:crypto';
import { encryptAes128Ecb } from '../crypto/aes-gcm.js';
import type { CdnMedia, WeixinBotConfig, WeixinChannelAccount } from './types.js';
import { DEFAULT_CDN_BASE } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_FILE = 3;
const MEDIA_TYPE_VOICE = 4;
const MAX_RETRIES = 2;

export class WeixinMediaUploadService {
  private readonly httpClient: WeixinHttpClient;

  constructor(
    private readonly weixinBotConfig: WeixinBotConfig,
    httpClient?: WeixinHttpClient,
  ) {
    this.httpClient = httpClient ?? createWeixinHttpClient(60_000);
  }

  uploadImage(account: WeixinChannelAccount, toUserId: string, plaintext: Buffer): Promise<CdnMedia | null> {
    return this.uploadMedia(account, toUserId, MEDIA_TYPE_IMAGE, plaintext);
  }

  uploadFile(account: WeixinChannelAccount, toUserId: string, plaintext: Buffer): Promise<CdnMedia | null> {
    return this.uploadMedia(account, toUserId, MEDIA_TYPE_FILE, plaintext);
  }

  uploadVoice(account: WeixinChannelAccount, toUserId: string, plaintext: Buffer): Promise<CdnMedia | null> {
    return this.uploadMedia(account, toUserId, MEDIA_TYPE_VOICE, plaintext);
  }

  private async uploadMedia(
    account: WeixinChannelAccount,
    toUserId: string,
    mediaType: number,
    plaintext: Buffer,
  ): Promise<CdnMedia | null> {
    let lastException: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.info(`微信媒体上传重试, accountId=${account.accountId}, attempt=${attempt}`);
          await sleep(1000 * attempt);
        }
        return await this.doUpload(account, toUserId, mediaType, plaintext);
      } catch (e) {
        lastException = e;
        if (!isRetryableNetworkFailure(e)) break;
      }
    }
    console.warn(`微信媒体上传失败, accountId=${account.accountId}: ${lastException instanceof Error ? lastException.message : 'unknown'}`);
    return null;
  }

  private async doUpload(
    account: WeixinChannelAccount,
    toUserId: string,
    mediaType: number,
    plaintext: Buffer,
  ): Promise<CdnMedia | null> {
    const payload = JSON.parse(account.payloadJson ?? '{}') as { token: string; baseUrl: string };
    const botToken = payload.token;
    const baseUrl = payload.baseUrl;
    const filekey = randomHex(16);
    const aesKeyHex = randomHex(16);
    const rawsize = plaintext.length;
    const rawfilemd5 = md5Hex(plaintext);
    const filesize = (Math.floor(rawsize / 16) + 1) * 16;
    const uploadUrl = await this.requestUploadUrl(
      baseUrl, botToken, toUserId, filekey, aesKeyHex, mediaType, rawsize, rawfilemd5, filesize,
    );
    if (uploadUrl == null || uploadUrl.trim() === '') {
      console.warn(`微信媒体上传：getuploadurl 未返回上传地址, accountId=${account.accountId}`);
      return null;
    }
    const ciphertext = encryptAes128Ecb(plaintext, hexToBytes(aesKeyHex));
    const encryptedParam = await this.uploadToCdn(uploadUrl, ciphertext);
    if (encryptedParam == null || encryptedParam.trim() === '') {
      console.warn(`微信媒体上传：CDN 上传未返回 x-encrypted-param, accountId=${account.accountId}`);
      return null;
    }
    const aesKeyB64 = Buffer.from(aesKeyHex, 'ascii').toString('base64');
    console.info(`微信媒体上传成功, accountId=${account.accountId}, mediaType=${mediaType}, rawsize=${rawsize}, ciphertext=${ciphertext.length}`);
    return {
      encryptQueryParam: encryptedParam,
      aesKey: aesKeyB64,
      encryptType: 1,
      size: ciphertext.length,
      rawSize: rawsize,
      rawMd5: rawfilemd5,
    };
  }

  private async requestUploadUrl(
    baseUrl: string,
    botToken: string,
    toUserId: string,
    filekey: string,
    aesKeyHex: string,
    mediaType: number,
    rawsize: number,
    rawfilemd5: string,
    filesize: number,
  ): Promise<string | null> {
    const body = {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: 'mao-server-1.0' },
    };
    const response = await this.httpClient.request(`${baseUrl}/ilink/bot/getuploadurl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${botToken}`,
        'X-WECHAT-UIN': randomWechatUin(),
      },
      body: JSON.stringify(body),
    });
    const responseBody = response.body.toString('utf8');
    if (response.status < 200 || response.status >= 300) {
      console.warn(`微信媒体上传：getuploadurl HTTP ${response.status}, body=${responseBody.slice(0, 500)}`);
      return null;
    }
    const node = JSON.parse(responseBody || '{}') as { upload_full_url?: string; upload_param?: string };
    if (node.upload_full_url != null && node.upload_full_url.trim() !== '') {
      return node.upload_full_url;
    }
    if (node.upload_param != null && node.upload_param.trim() !== '') {
      let cdnBase = this.weixinBotConfig.cdnBaseUrl;
      if (cdnBase == null || cdnBase.trim() === '') cdnBase = DEFAULT_CDN_BASE;
      if (cdnBase.endsWith('/')) cdnBase = cdnBase.slice(0, -1);
      return `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(node.upload_param)}&filekey=${filekey}`;
    }
    console.warn(`微信媒体上传：getuploadurl 响应缺少 upload_full_url/upload_param, body=${responseBody.slice(0, 500)}`);
    return null;
  }

  private async uploadToCdn(uploadUrl: string, ciphertext: Buffer): Promise<string | null> {
    const response = await this.httpClient.request(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
    });
    if (response.status < 200 || response.status >= 300) {
      console.warn(`微信媒体上传：CDN upload HTTP ${response.status}, x-error-message=${response.header('x-error-message')}`);
      return null;
    }
    return response.header('x-encrypted-param') ?? null;
  }
}

function isRetryableNetworkFailure(failure: unknown): boolean {
  let cause: unknown = failure;
  while (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '';
    if (
      code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE'
      || msg.includes('timeout') || msg.includes('socket') || msg.includes('ECONN')
    ) {
      return true;
    }
    cause = cause instanceof Error ? cause.cause : null;
  }
  return false;
}

function md5Hex(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex');
}

function randomHex(byteLen: number): string {
  return randomBytes(byteLen).toString('hex');
}

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

function randomWechatUin(): string {
  const value = (Math.floor(Math.random() * 0x100000000)) >>> 0;
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
