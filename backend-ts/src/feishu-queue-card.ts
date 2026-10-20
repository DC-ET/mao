import * as Lark from '@larksuiteoapi/node-sdk';
import { buildFeishuQueueCard } from './feishu-cards.js';
import type { FeishuInboundContext } from './feishu/types.js';
import type { FeishuMessageService } from './feishu/message.service.js';

export interface FeishuQueueCardDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuMessageService: FeishuMessageService;
}

export function createFeishuQueueCardHelper(deps: FeishuQueueCardDeps) {
  const { getFeishuClient, feishuMessageService } = deps;

  return async (context: FeishuInboundContext, queueId: number, position: number, sessionId: number): Promise<string | null> => {
    const client = await getFeishuClient(Number(context.accountId));
    if (client == null) return null;
    const data = { msg_type: 'interactive', content: JSON.stringify(buildFeishuQueueCard(context, queueId, position)) };
    // 群聊用 reply 触发消息：话题群中 message.create 到 chat_id 会创建新话题，reply 才落入当前话题。
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { ...data, receive_id: context.senderId! } }));
    const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    // 私聊排队卡片可被回复/引用，记录卡片消息 → 会话映射供引用切换定位。
    if (cardMessageId != null && context.chatType === 'p2p') {
      await feishuMessageService.recordP2pMessage(context.accountId, cardMessageId, sessionId, 'OUT');
    }
    return cardMessageId;
  };
}
