import { randomUUID } from 'node:crypto';
import type { WeixinAccountRepository } from './account.repository.js';
import type { ContextTokenRepository } from './context-token.repository.js';
import type { CdnMedia } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

/**
 * 微信文本消息单条字节上限：ilink 协议未公开该常量。
 * 实测（2026-10-10 对线上网关探测）：纯 ASCII 约 16KB 内可通过，含中文时 6000 字节是通过上限、
 * 6003 字节即被拒 `{"ret":-2,"errmsg":"prepare failed"}`。取 CJK 场景实测值 6000 字节作为通用上限，
 * 按 UTF-8 字节数切分，避免按字符数切分时中文消息被高估成多条而浪费配额。
 */
export const WEIXIN_MAX_TEXT_BYTES = 6000;
/** 分片边界的最小可接受比例：附近没有合适分隔符时宁可硬切，避免切出过短碎片。 */
const MIN_CHUNK_RATIO = 0.5;
/** ilink 原始响应体落日志的截断长度。 */
const LOG_BODY_MAX_CHARS = 300;

/**
 * 按微信单条字节上限切分回复：优先段落（`\n\n`）、行（`\n`）、空格边界，都没有则硬切。
 * 每条分片由调用方以独立 `client_id` 发送，用户侧表现为连续多条气泡。
 */
export function splitTextForWeixin(text: string, maxBytes: number = WEIXIN_MAX_TEXT_BYTES): string[] {
  if (text === '') return [];
  if (maxBytes <= 0 || Buffer.byteLength(text) <= maxBytes) return [text];
  const minBytes = Math.max(1, Math.floor(maxBytes * MIN_CHUNK_RATIO));
  const chunks: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest) > maxBytes) {
    const cut = findCut(rest, maxBytes, minBytes);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

/** 取 text 的字节预算内最长字符前缀长度；逐字符累积保证不切出半个多字节字符。 */
function prefixLenWithinBytes(text: string, maxBytes: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const next = bytes + Buffer.byteLength(text[i]);
    if (next > maxBytes) break;
    bytes = next;
    i += 1;
  }
  return i;
}

/** 在 [minBytes, maxBytes] 字节预算内找最后一个分隔符；找不到返回预算对应的字符数硬切。 */
function findCut(text: string, maxBytes: number, minBytes: number): number {
  // 窗口必须按字节预算取，不能按字符数取：中文场景下 maxBytes 个字符≈3 倍字节，
  // 否则 lastIndexOf 找到的分隔符会落在字节预算之外，切出超限分片。
  const limit = prefixLenWithinBytes(text, maxBytes);
  const window = text.slice(0, limit);
  const boundaries: Array<[string, number]> = [['\n\n', 2], ['\n', 1], [' ', 1]];
  for (const [sep, keep] of boundaries) {
    const at = window.lastIndexOf(sep);
    if (at < 0) continue;
    // 分隔符位置按字节衡量：中文场景下字符数远小于字节数，必须换算后才知是否落在前半段预算内。
    if (Buffer.byteLength(window.slice(0, at)) >= minBytes) return at + keep;
  }
  return Math.max(1, limit);
}

/** ilink 原始响应体脱敏后落日志：截断长度并遮罩 token/secret，便于定位 ret=-2 这类未公开错误码。 */
export function sanitizeIlinkBody(body: Buffer | string): string {
  const raw = (Buffer.isBuffer(body) ? body.toString('utf8') : body).trim();
  if (raw === '') return '<empty>';
  const masked = raw.replace(/"([^"]*(?:token|secret)[^"]*)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
  return masked.length > LOG_BODY_MAX_CHARS ? `${masked.slice(0, LOG_BODY_MAX_CHARS)}…` : masked;
}

export class WeixinSendService {
  private readonly httpClient: WeixinHttpClient;

  constructor(
    private readonly accountRepository: WeixinAccountRepository,
    private readonly contextTokenRepository: ContextTokenRepository,
    httpClient?: WeixinHttpClient,
  ) {
    this.httpClient = httpClient ?? createWeixinHttpClient(60_000);
  }

  /**
   * 发送文本回复。超过单条上限时按边界切分为多条气泡，逐条以独立 `client_id` 发送，
   * 任一一片失败即整体失败（用户侧可能已收到前半段，故返回 false 让调用方感知并降级提示）。
   */
  async sendText(accountId: string, toUserId: string, text: string): Promise<boolean> {
    const chunks = splitTextForWeixin(text);
    if (chunks.length === 0) return false;
    if (chunks.length === 1) {
      return this.sendMessage(accountId, toUserId, [{ type: 1, text_item: { text: chunks[0] } }]);
    }
    console.info(`微信长回复分片发送, accountId=${accountId}, toUserId=${toUserId}, chars=${text.length}, chunks=${chunks.length}`);
    for (const chunk of chunks) {
      const ok = await this.sendMessage(accountId, toUserId, [{ type: 1, text_item: { text: chunk } }]);
      if (!ok) {
        console.error(`微信长回复分片发送中断, accountId=${accountId}, toUserId=${toUserId}, chunks=${chunks.length}`);
        return false;
      }
    }
    return true;
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
        console.error(`发送消息失败: HTTP ${response.status}, accountId=${accountId}, toUserId=${toUserId}, body=${sanitizeIlinkBody(response.body)}`);
        return false;
      }
      const body = response.body.toString('utf8');
      if (body.trim() === '' || body.trim() === '{}') {
        return true;
      }
      const responseJson = JSON.parse(body) as { ret?: number; errcode?: number; errmsg?: string };
      if (responseJson.ret == null && responseJson.errcode == null) {
        return true;
      }
      const ret = responseJson.ret ?? 0;
      const errcode = responseJson.errcode ?? 0;
      if (ret === 0 && errcode === 0) return true;
      // errmsg 单独提出：ilink 未公开错误码字典，errmsg（如 "prepare failed"）是区分
      // 「消息体过大」与「24 小时窗口过期」的关键线索，不能只埋在 body 里。
      const errmsg = responseJson.errmsg ?? '';
      const detail = errmsg !== '' ? `errmsg=${errmsg}, ` : '';
      console.error(`发送消息失败: ret=${ret}, errcode=${errcode}, ${detail}accountId=${accountId}, toUserId=${toUserId}, body=${sanitizeIlinkBody(response.body)}`);
      return false;
    } catch (e) {
      console.error(`发送消息异常, accountId=${accountId}, toUserId=${toUserId}`, e);
      return false;
    }
  }
}
