import { isInboundFileMessage, isUnsupportedMedia } from './event-normalizer.js';
import type { DingtalkMessageService } from './message.service.js';
import type { DingtalkInboundContext, DingtalkInboundHandler, DingtalkNormalizedMessage } from './types.js';

const IDENTITY_TEXT = '当前无法识别你的钉钉身份';
const OAUTH_MISSING_TEXT = '管理员尚未配置钉钉登录，暂时无法绑定';
const GROUP_UNSUPPORTED_TEXT = '群聊暂不支持该类型，请私聊发送';
const P2P_UNSUPPORTED_TEXT = '暂不支持语音和视频';

export interface DingtalkInboundProcessorOptions {
  messageService?: DingtalkMessageService;
  resolveUserId?: (accountId: string, event: DingtalkNormalizedMessage) => Promise<number | null>;
  sendReply?: (accountId: string, event: DingtalkNormalizedMessage, text: string) => Promise<void>;
  sendBindingCard?: (accountId: string, event: DingtalkNormalizedMessage) => Promise<boolean>;
  oauthConfigured?: () => boolean;
  rememberMember?: (accountId: string, event: DingtalkNormalizedMessage, userId: number) => Promise<void>;
}

export class DingtalkInboundProcessor {
  constructor(private readonly handler: DingtalkInboundHandler, private readonly options: DingtalkInboundProcessorOptions = {}) {}

  async process(accountId: string, event: DingtalkNormalizedMessage, skipClaim = false): Promise<void> {
    const messageService = this.options.messageService;
    const claimed = skipClaim || messageService == null ? true : await messageService.claimInbound(accountId, event);
    if (!claimed) return;
    let completed = false;
    try {
      if (event.senderUserid == null || event.senderUserid === '') {
        await this.reply(accountId, event, IDENTITY_TEXT);
        completed = true;
        return;
      }
      if (event.chatType === 'group' && !event.isInAtList) {
        console.info(`钉钉群消息未 @ 本机器人, bot=${accountId}, messageId=${event.messageId}`);
        completed = true;
        return;
      }
      const userId = await this.options.resolveUserId?.(accountId, event) ?? null;
      if (event.chatType === 'group' && event.isInAtList && messageService != null) {
        await messageService.recordGroupInbound(accountId, event);
      }
      if (userId == null) {
        await this.sendBindingGuide(accountId, event);
        completed = true;
        return;
      }
      if (event.chatType === 'group' && messageService != null) {
        await this.options.rememberMember?.(accountId, event, userId);
      }
      const unsupported = isUnsupportedMedia(event);
      if (unsupported != null) {
        await this.reply(accountId, event, unsupported === 'group' ? GROUP_UNSUPPORTED_TEXT : P2P_UNSUPPORTED_TEXT);
        completed = true;
        return;
      }
      let groupContext = '';
      if (event.chatType === 'group' && messageService != null && !isInboundFileMessage(event)) {
        groupContext = await messageService.buildGroupContext(accountId, event.conversationId, event.messageId);
      }
      const context: DingtalkInboundContext = {
        ...event,
        accountId,
        maoUserId: userId,
        groupContext,
        senderLabel: event.senderName,
      };
      await this.handler.onMessage(context);
      completed = true;
    } finally {
      if (messageService != null) {
        if (completed) await messageService.completeInbound(accountId, event.messageId);
        else await messageService.releaseInbound(accountId, event.messageId);
      }
    }
  }

  private async sendBindingGuide(accountId: string, event: DingtalkNormalizedMessage): Promise<void> {
    if (this.options.oauthConfigured != null && !this.options.oauthConfigured()) {
      await this.reply(accountId, event, OAUTH_MISSING_TEXT);
      return;
    }
    const sent = await this.options.sendBindingCard?.(accountId, event) ?? false;
    if (!sent) await this.reply(accountId, event, OAUTH_MISSING_TEXT);
  }

  private async reply(accountId: string, event: DingtalkNormalizedMessage, text: string): Promise<void> {
    await this.options.sendReply?.(accountId, event, text);
  }
}

export { IDENTITY_TEXT, OAUTH_MISSING_TEXT, GROUP_UNSUPPORTED_TEXT, P2P_UNSUPPORTED_TEXT };
