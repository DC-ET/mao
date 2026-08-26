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
  sendUnauthorizedCard?: (accountId: string, event: FeishuNormalizedMessage) => Promise<boolean>;
  /** 未绑定/未授权时的引导文案；可包含绑定链接。 */
  unauthorizedText?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string> | string;
  resolveSenderName?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  /** 解析被引用/回复消息的内容文本（含 [引用消息] 前缀）；返回 null 表示无法解析。 */
  resolveQuotedMessage?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  /** 群聊图片入站即下载（非懒加载）：返回落盘绝对路径嵌入占位文本；null/抛错表示失败，保留懒加载占位符。 */
  downloadGroupImage?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
}

export class FeishuInboundProcessor {
  constructor(private readonly handler: FeishuInboundHandler, private readonly options: FeishuInboundProcessorOptions = {}) {}

  async process(accountId: string, event: FeishuNormalizedMessage, skipClaim = false): Promise<void> {
    if (event.senderId == null || event.messageId == null) return;
    // 媒体消息（图片/文件）无文本时生成标注文本，避免空消息进入链路且群日志内容为空。
    let normalized = await this.resolveSenderName(event, accountId);
    normalized = this.normalizeText(normalized);
    const messageId = normalized.messageId!;
    const messageService = this.options.messageService;
    const claimed = skipClaim || messageService == null
      ? true
      : await messageService.claimInboundMessage(accountId, { ...normalized, accountId, messageId });
    if (messageService != null && !claimed) return;
    normalized = await this.prewarmGroupImage(accountId, normalized);
    let completed = false;
    try {
      if (normalized.chatType === 'p2p') {
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, normalized))) {
          await this.options.onUnauthorized?.(accountId, normalized);
          await this.sendUnauthorized(accountId, normalized);
        } else if (this.handler.authorizeDirectMessage(accountId, normalized.senderUnionId ?? normalized.senderId!, normalized.text)) {
          const resolvedUserId = await this.options.resolveUserId?.(accountId, normalized);
          const quotedContext = await this.resolveQuoted(accountId, normalized);
          const reply = await this.handler.onMessage({ ...normalized, accountId, maoUserId: resolvedUserId ?? undefined, quotedContext });
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
        let sentCard = false;
        try {
          sentCard = await this.options.sendUnauthorizedCard?.(accountId, normalized) ?? false;
        } catch (error) {
          console.warn(`飞书绑定卡片发送失败，使用文本回退: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!sentCard) await this.sendUnauthorized(accountId, normalized);
        completed = true;
        return;
      }
      const resolvedUserId = await this.options.resolveUserId?.(accountId, normalized);
      const group = await messageService.buildGroupContext(accountId, { ...normalized, accountId, messageId, maoUserId: resolvedUserId ?? undefined });
      const quotedContext = await this.resolveQuoted(accountId, normalized);
      const context: FeishuInboundContext = {
        ...normalized, accountId, messageId, maoUserId: resolvedUserId ?? undefined, groupContext: group.prompt,
        senderLabel: this.options.senderLabel?.(normalized) ?? defaultSenderLabel(normalized),
        quotedContext,
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

  /** 解析被引用/回复消息内容；失败降级为无引用（引用内容属任务意图核心，但不阻塞主流程）。 */
  private async resolveQuoted(accountId: string, event: FeishuNormalizedMessage): Promise<string | undefined> {
    if (event.parentId == null || event.parentId === '' || this.options.resolveQuotedMessage == null) return undefined;
    try {
      const quoted = await this.options.resolveQuotedMessage(accountId, event);
      return quoted == null || quoted.trim() === '' ? undefined : quoted;
    } catch (error) {
      console.warn(`解析飞书引用消息失败, messageId=${event.messageId}, parentId=${event.parentId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** 群图片入站预下载：成功则占位文本携带 @{路径}@ 引用（Agent 免工具直接读取），失败保留 msg 占位符走懒加载兜底。 */
  private async prewarmGroupImage(accountId: string, event: FeishuNormalizedMessage): Promise<FeishuNormalizedMessage> {
    if (event.chatType !== 'group' || event.messageType !== 'image' || this.options.downloadGroupImage == null) return event;
    try {
      const path = await this.options.downloadGroupImage(accountId, event);
      if (path == null || path === '') return event;
      // 飞书图片消息无文本，text 此时只可能是懒加载占位符，直接整体替换。
      return { ...event, text: `[图片已保存: @{${path}}@]` };
    } catch (error) {
      console.warn(`飞书群图片预下载失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
      return event;
    }
  }

  private normalizeText(event: FeishuNormalizedMessage): FeishuNormalizedMessage {
    const rawText = event.text?.trim() ?? '';
    if (rawText !== '') return event;
    // 媒体消息（图片/文件）无文本时生成标注文本；占位符携带消息 ID，
    // 供 Agent 在飞书通道会话中通过 feishu_download_file 工具按需下载。
    let placeholder = '';
    if (event.messageType === 'image') placeholder = `[图片 msg=${event.messageId ?? '未知'}]`;
    else if (event.messageType === 'file') placeholder = `[文件:${event.fileName ?? event.fileKey ?? '未知文件'} msg=${event.messageId ?? '未知'}]`;
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
