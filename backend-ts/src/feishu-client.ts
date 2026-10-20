import * as Lark from '@larksuiteoapi/node-sdk';
import { decryptAesGcm } from './crypto/aes-gcm.js';
import type { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import type { FeishuNormalizedMessage } from './feishu/types.js';

export interface FeishuClientDeps {
  feishuBots: MysqlFeishuBotRepository;
  appSecretKey: string;
  replyMaxLength: number;
}

export interface FeishuClientHelper {
  getFeishuClient(botId: number): Promise<Lark.Client | null>;
  getFeishuChatTitle(botId: number, chatId: string): Promise<string>;
  sendFeishuText(botId: number, event: FeishuNormalizedMessage, text: string): Promise<string | null>;
}

export function createFeishuClientHelper(deps: FeishuClientDeps): FeishuClientHelper {
  const { feishuBots, appSecretKey, replyMaxLength } = deps;
  const feishuClients = new Map<string, Lark.Client>();
  const feishuChatTitles = new Map<string, Promise<string>>();

  const getFeishuClient = async (botId: number): Promise<Lark.Client | null> => {
    const bot = await feishuBots.findById(botId);
    if (bot == null || bot.enabled === 0 || !appSecretKey) return null;
    const key = `${botId}:${bot.appId}:${bot.appSecret}`;
    const cached = feishuClients.get(key);
    if (cached != null) return cached;
    const appSecret = decryptAesGcm(bot.appSecret, appSecretKey, '飞书Bot appSecret解密失败');
    const client = new Lark.Client({ appId: bot.appId, appSecret });
    feishuClients.set(key, client);
    return client;
  };

  const getFeishuChatTitle = (botId: number, chatId: string): Promise<string> => {
    const key = `${botId}:${chatId}`;
    const cached = feishuChatTitles.get(key);
    if (cached != null) return cached;
    const promise = (async () => {
      try {
        const client = await getFeishuClient(botId);
        if (client == null) return '';
        const response = await client.im.v1.chat.get({ path: { chat_id: chatId } });
        return (response as { data?: { name?: string } }).data?.name?.trim() ?? '';
      } catch (error) {
        console.warn(`获取飞书群名称失败, botId=${botId}, chatId=${chatId}: ${error instanceof Error ? error.message : String(error)}`);
        return '';
      }
    })();
    feishuChatTitles.set(key, promise);
    return promise;
  };

  const sendFeishuText = async (botId: number, event: FeishuNormalizedMessage, text: string): Promise<string | null> => {
    const client = await getFeishuClient(botId);
    if (client == null) return null;
    const maxReplyLength = Math.max(100, Math.min(10000, replyMaxLength));
    const limited = text.length > maxReplyLength ? `${text.slice(0, maxReplyLength)}…（回复过长已截断）` : text;
    if (event.chatType === 'group' && event.messageId != null) {
      const response = await client.im.v1.message.reply({
        path: { message_id: event.messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: limited }) },
      });
      return (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    }
    const receiveId = event.chatType === 'group' ? event.chatId : event.senderId;
    const receiveIdType = event.chatType === 'group' ? 'chat_id' : 'open_id';
    if (receiveId == null) return null;
    const response = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: limited }) },
    });
    return (response as { data?: { message_id?: string } }).data?.message_id ?? null;
  };

  return { getFeishuClient, getFeishuChatTitle, sendFeishuText };
}
