import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { EcpAuthService } from './auth/ecp-auth.service.js';
import type { FeishuAuthService } from './auth/feishu-auth.service.js';
import type { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import {
  buildFeishuAuthGuideCard,
  feishuUnauthorizedGuide,
  persistFeishuPendingAuth,
  startFeishuChannelAuthLink,
} from './feishu/ecp-inbound-gate.js';

export interface SendUnauthorizedCardDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  ecpAuth: EcpAuthService;
  feishu: FeishuAuthService;
  pendingBindingMessages: MysqlFeishuPendingBindingRepository;
}

export function createSendUnauthorizedCardHelper(deps: SendUnauthorizedCardDeps) {
  const { getFeishuClient, ecpAuth, feishu, pendingBindingMessages } = deps;

  return async (accountId: string, event: FeishuNormalizedMessage): Promise<boolean> => {
    const client = await getFeishuClient(Number(accountId));
    if (client == null || event.messageId == null) return false;
    if (event.chatType === 'group' && event.chatId == null) return false;
    if (event.chatType === 'p2p' && event.senderId == null) return false;
    let auth: { authUrl: string; state: string } | null = null;
    try {
      auth = await startFeishuChannelAuthLink({
        ecpEnabled: await ecpAuth.isEnabled(),
        feishuEnabled: await feishu.isEnabled(),
        startEcp: () => ecpAuth.startFeishuLogin('desktop'),
        startFeishu: () => feishu.getQrCodeUrl(),
      });
    } catch (error) {
      console.error('飞书未授权引导获取登录链接失败', error);
      return false;
    }
    if (auth == null || auth.authUrl.trim() === '') return false;
    const inboundMessageId = event.messageId;
    const persisted = await persistFeishuPendingAuth(
      () => pendingBindingMessages.insert({ state: auth.state, appId: Number(accountId), messageId: inboundMessageId, event }),
      auth.state,
    );
    const ecpEnabled = await ecpAuth.isEnabled();
    const guide = feishuUnauthorizedGuide(ecpEnabled, event.chatType);
    const card = buildFeishuAuthGuideCard(guide, auth.authUrl);
    const data = { msg_type: 'interactive' as const, content: JSON.stringify(card) };
    let response;
    try {
      response = await (event.chatType === 'group'
        ? client.im.v1.message.reply({ path: { message_id: inboundMessageId }, data })
        : client.im.v1.message.create({
            params: { receive_id_type: 'open_id' },
            data: { ...data, receive_id: event.senderId! },
          }));
    } catch (error) {
      if (persisted) await pendingBindingMessages.fail(auth.state);
      throw error;
    }
    const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id;
    if (cardMessageId == null || cardMessageId === '') {
      if (persisted) await pendingBindingMessages.fail(auth.state);
      return false;
    }
    if (persisted) {
      try {
        await pendingBindingMessages.setCardMessageId(auth.state, cardMessageId);
      } catch (error) {
        console.error(`飞书登录引导卡片已发送但回写 card_message_id 失败, state=${auth.state}`, error);
      }
    }
    return true;
  };
}
