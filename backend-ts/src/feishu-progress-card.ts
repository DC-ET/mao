import * as Lark from '@larksuiteoapi/node-sdk';
import { buildFeishuProgressCard } from './feishu/progress-card.js';
import type { FeishuCardProgress } from './feishu/card-progress-listener.js';
import type { FeishuInboundContext } from './feishu/types.js';
import type { FeishuMessageService } from './feishu/message.service.js';
import type { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';

export interface FeishuProgressCardDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuMessageService: FeishuMessageService;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
  resolveFeishuSessionDetailUrl: (sessionId: number) => Promise<string | undefined>;
  createPatchedProgress: (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
    botId?: number,
  ) => FeishuCardProgress;
}

export function createFeishuProgressCardHelper(deps: FeishuProgressCardDeps) {
  const { getFeishuClient, feishuMessageService, feishuProgressCardRepo, resolveFeishuSessionDetailUrl, createPatchedProgress } = deps;

  return async (context: FeishuInboundContext, sessionId: number): Promise<FeishuCardProgress | null> => {
    const botId = Number(context.accountId);
    const client = await getFeishuClient(botId);
    if (client == null) return null;
    const cancelAction = { sessionId, sender: context.senderId ?? '', botId };
    const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
    const persistCard = async (cardMessageId: string): Promise<void> => {
      try {
        await feishuProgressCardRepo.upsert({
          sessionId, botId, cardMessageId,
          chatType: context.chatType,
          chatId: context.chatId,
          senderOpenId: context.senderId,
        });
      } catch (error) {
        console.warn(`飞书进度卡片映射持久化失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const existingMessageId = context.progressCardMessageId;
    const startedAtMs = Date.now();
    if (existingMessageId != null) {
      const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', [], cancelAction, undefined, sessionDetailUrl);
      await client.im.v1.message.patch({ path: { message_id: existingMessageId }, data: { content: JSON.stringify(card) } });
      await persistCard(existingMessageId);
      return createPatchedProgress(client, existingMessageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
        content: '任务已接收，正在准备执行。',
      }, botId);
    }
    const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', [], cancelAction, undefined, sessionDetailUrl);
    const data = { msg_type: 'interactive', content: JSON.stringify(card) };
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({
        params: { receive_id_type: context.chatType === 'group' ? 'chat_id' : 'open_id' },
        data: { ...data, receive_id: context.chatType === 'group' ? context.chatId! : context.senderId! },
      }));
    const messageId = (response as { data?: { message_id?: string } }).data?.message_id;
    if (messageId == null || messageId === '') throw new Error('飞书处理中卡片发送失败：未返回 message_id');
    await persistCard(messageId);
    if (context.chatType === 'p2p') await feishuMessageService.recordP2pMessage(String(botId), messageId, sessionId, 'OUT');
    return createPatchedProgress(client, messageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
      content: '任务已接收，正在准备执行。',
    }, botId);
  };
}
