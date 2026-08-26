import type { FeishuInboundHandler, FeishuNormalizedMessage, FeishuInboundContext, FeishuReply } from './types.js';
import type { FeishuMessageService } from './message.service.js';

export interface FeishuInboundProcessorOptions {
  messageService?: FeishuMessageService;
  isBotMentioned?: (event: FeishuNormalizedMessage) => boolean;
  senderLabel?: (event: FeishuNormalizedMessage) => string;
  sendReply?: (accountId: string, event: FeishuNormalizedMessage, text: string) => Promise<void>;
  authorizeSender?: (accountId: string, event: FeishuNormalizedMessage) => Promise<boolean>;
  resolveUserId?: (accountId: string, event: FeishuNormalizedMessage) => Promise<number | null>;
  onUnauthorized?: (accountId: string, event: FeishuNormalizedMessage) => Promise<void>;
  /** 未绑定/未授权时的引导文案；可包含绑定链接。 */
  unauthorizedText?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string> | string;
  resolveSenderName?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
}

export class FeishuInboundProcessor {
  constructor(private readonly handler: FeishuInboundHandler, private readonly options: FeishuInboundProcessorOptions = {}) {}

  async process(accountId: string, event: FeishuNormalizedMessage): Promise<void> {
    if (event.senderId == null || event.messageId == null) return;
    // 媒体消息（图片/文件）无文本时生成标注文本，避免空消息进入链路且群日志内容为空。
    let normalized = await this.resolveSenderName(event, accountId);
    normalized = this.normalizeText(normalized);
    const messageId = normalized.messageId!;
    const messageService = this.options.messageService;
    const claimed = messageService == null
      ? false
      : await messageService.claimInboundMessage(accountId, { ...normalized, accountId, messageId });
    if (messageService != null && !claimed) return;
    let completed = false;
    try {
      if (normalized.chatType === 'p2p') {
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, normalized))) {
          await this.options.onUnauthorized?.(accountId, normalized);
          await this.sendUnauthorized(accountId, normalized);
        } else if (this.handler.authorizeDirectMessage(accountId, normalized.senderUnionId ?? normalized.senderId!, normalized.text)) {
          const resolvedUserId = await this.options.resolveUserId?.(accountId, normalized);
          const reply = await this.handler.onMessage({ ...normalized, accountId, maoUserId: resolvedUserId ?? undefined });
          if (reply?.text) await this.sendReply(accountId, normalized, reply);
        }
        completed = true;
        return;
      }
      if (normalized.chatType !== 'group' || messageService == null) {
        completed = true;
        return;
      }
      const mentioned = this.isBotMentioned(normalized);
      await messageService.recordGroupMessage(accountId, { ...normalized, accountId, messageId }, mentioned);
      if (!mentioned) {
        completed = true;
        return;
      }
      if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, normalized))) {
        await this.options.onUnauthorized?.(accountId, normalized);
        await this.sendUnauthorized(accountId, normalized);
        completed = true;
        return;
      }
      const resolvedUserId = await this.options.resolveUserId?.(accountId, normalized);
      const group = await messageService.buildGroupContext(accountId, { ...normalized, accountId, messageId, maoUserId: resolvedUserId ?? undefined });
      const context: FeishuInboundContext = {
        ...normalized, accountId, messageId, maoUserId: resolvedUserId ?? undefined, groupContext: group.prompt,
        senderLabel: this.options.senderLabel?.(normalized) ?? defaultSenderLabel(normalized),
      };
      const reply = await this.handler.onMessage(context);
      if (reply?.text) await this.sendReply(accountId, normalized, reply);
      completed = true;
    } finally {
      if (messageService != null) {
        if (completed) await messageService.completeInboundMessage(accountId, messageId);
        else await messageService.releaseInboundMessage(accountId, messageId);
      }
    }
  }

  private async resolveSenderName(event: FeishuNormalizedMessage, accountId: string): Promise<FeishuNormalizedMessage> {
    if (event.senderName != null && event.senderName.trim() !== '') return event;
    const name = await this.options.resolveSenderName?.(accountId, event);
    return name == null || name.trim() === '' ? event : { ...event, senderName: name };
  }

  private normalizeText(event: FeishuNormalizedMessage): FeishuNormalizedMessage {
    const rawText = event.text?.trim() ?? '';
    if (rawText !== '') return event;
    let placeholder = '';
    if (event.messageType === 'image') placeholder = '[图片]';
    else if (event.messageType === 'file') placeholder = `[文件:${event.fileName ?? event.fileKey ?? '未知文件'}]`;
    if (placeholder === '') return event;
    return { ...event, text: placeholder };
  }

  private async sendUnauthorized(accountId: string, event: FeishuNormalizedMessage): Promise<void> {
    const text = await this.options.unauthorizedText?.(accountId, event) ?? defaultUnauthorizedText(event);
    await this.sendReply(accountId, event, { text });
  }

  private async sendReply(accountId: string, event: FeishuNormalizedMessage, reply: FeishuReply): Promise<void> {
    await this.options.sendReply?.(accountId, event, reply.text ?? '');
  }

  private isBotMentioned(event: FeishuNormalizedMessage): boolean {
    return this.options.isBotMentioned?.(event) ?? event.isBotMentioned;
  }
}

function defaultSenderLabel(event: FeishuNormalizedMessage): string {
  if (event.senderName != null && event.senderName.trim() !== '') return event.senderName;
  const raw = event.rawEvent as Record<string, any>;
  return raw?.event?.sender?.sender_id?.name ?? raw?.event?.sender?.name ?? event.senderId ?? '未知用户';
}

function defaultUnauthorizedText(event: FeishuNormalizedMessage): string {
  return event.chatType === 'group'
    ? '请先完成飞书账号绑定，获得群内使用权限后再试。'
    : '请先完成飞书账号绑定后再试。';
}
