import { randomUUID } from 'node:crypto';
import type { WeixinAccountRepository } from './account.repository.js';
import type { ContextTokenRepository } from './context-token.repository.js';
import type { CdnMedia } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

export class WeixinSendService {
  private readonly httpClient: WeixinHttpClient;

  constructor(
    private readonly accountRepository: WeixinAccountRepository,
    private readonly contextTokenRepository: ContextTokenRepository,
    httpClient?: WeixinHttpClient,
  ) {
    this.httpClient = httpClient ?? createWeixinHttpClient(60_000);
  }

  sendText(accountId: string, toUserId: string, text: string): Promise<boolean> {
    const textItem = { type: 1, text_item: { text } };
    return this.sendMessage(accountId, toUserId, [textItem]);
  }

  sendVoice(
    accountId: string,
    toUserId: string,
    media: CdnMedia,
    sampleRate: number,
    playtimeMs: number,
    transcript: string | null,
  ): Promise<boolean> {
    const mediaMap = {
      encrypt_query_param: media.encryptQueryParam,
      aes_key: media.aesKey,
      encrypt_type: media.encryptType,
    };
    const voiceItem = {
      type: 3,
      voice_item: {
        media: mediaMap,
        encode_type: 6,
        bits_per_sample: 16,
        sample_rate: sampleRate,
        playtime: playtimeMs,
        text: transcript ?? '',
      },
    };
    return this.sendMessage(accountId, toUserId, [voiceItem]);
  }

  sendImage(accountId: string, toUserId: string, media: CdnMedia): Promise<boolean> {
    const mediaMap = {
      encrypt_query_param: media.encryptQueryParam,
      aes_key: media.aesKey,
      encrypt_type: media.encryptType,
    };
    const imageItem = {
      type: 2,
      image_item: { media: mediaMap, mid_size: media.size },
    };
    return this.sendMessage(accountId, toUserId, [imageItem]);
  }

  sendFile(accountId: string, toUserId: string, media: CdnMedia, fileName: string): Promise<boolean> {
    const mediaMap = {
      encrypt_query_param: media.encryptQueryParam,
      aes_key: media.aesKey,
      encrypt_type: media.encryptType,
    };
    const fileItem = {
      type: 4,
      file_item: {
        media: mediaMap,
        file_name: fileName,
        md5: media.rawMd5,
        len: String(media.rawSize),
      },
    };
    return this.sendMessage(accountId, toUserId, [fileItem]);
  }

  async sendMessage(accountId: string, toUserId: string, itemList: unknown[]): Promise<boolean> {
    const account = await this.accountRepository.findByAccountId(accountId);
    if (account == null) {
      console.error(`发送消息失败: 账号不存在, accountId=${accountId}`);
      return false;
    }
    let botToken: string;
    let baseUrl: string;
    try {
      const payload = JSON.parse(account.payloadJson ?? '{}') as { token: string; baseUrl: string };
      botToken = payload.token;
      baseUrl = payload.baseUrl;
    } catch (e) {
      console.error(`解析账号凭据失败, accountId=${accountId}`, e);
      return false;
    }
    const contextToken = await this.contextTokenRepository.getLatestToken(accountId, toUserId);
    if (contextToken == null || contextToken === '') {
      console.error(`发送消息失败: 缺少context_token, accountId=${accountId}, toUserId=${toUserId}`);
      return false;
    }
    const clientId = randomUUID();
    const message = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: itemList,
      },
      base_info: { channel_version: 'mao-server-1.0' },
    };
    try {
      const response = await this.httpClient.request(`${baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(message),
      });
      if (response.status < 200 || response.status >= 300) {
        console.error(`发送消息失败: HTTP ${response.status}, accountId=${accountId}, toUserId=${toUserId}`);
        return false;
      }
      const body = response.body.toString('utf8');
      if (body.trim() === '' || body.trim() === '{}') {
        return true;
      }
      const responseJson = JSON.parse(body) as { ret?: number; errcode?: number };
      if (responseJson.ret == null && responseJson.errcode == null) {
        return true;
      }
      const ret = responseJson.ret ?? 0;
      const errcode = responseJson.errcode ?? 0;
      if (ret === 0 && errcode === 0) return true;
      console.error(`发送消息失败: ret=${ret}, errcode=${errcode}, accountId=${accountId}, toUserId=${toUserId}`);
      return false;
    } catch (e) {
      console.error(`发送消息异常, accountId=${accountId}, toUserId=${toUserId}`, e);
      return false;
    }
  }
}
