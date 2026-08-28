import type { FeishuInboundHandler, FeishuNormalizedMessage, FeishuInboundContext, FeishuReply } from './types.js';
import type { FeishuMessageService } from './message.service.js';
import { botSenderLabel, isBotSender } from './message.service.js';
import { describeMessageText } from './message-detail.js';

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

  /** 同群保序门闩：群消息「写入日志」与触发时「读取上下文」必须按到达顺序执行，
   * 防止并发入站处理乱序（图片尚未入库、水位线已被触发推进，导致该消息永远进不了上下文）。 */
  private readonly chatOrderQueues = new Map<string, Promise<unknown>>();

  private runInChatOrder<T>(accountId: string, chatId: string | null, fn: () => Promise<T>): Promise<T> {
    const key = `${accountId}:${chatId ?? ''}`;
    const previous = this.chatOrderQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.chatOrderQueues.set(key, queued);
    return previous.then(fn).finally(() => {
      release();
      if (this.chatOrderQueues.get(key) === queued) this.chatOrderQueues.delete(key);
    });
  }

  async process(accountId: string, event: FeishuNormalizedMessage, skipClaim = false): Promise<void> {
    if (event.senderId == null || event.messageId == null) return;
    // 媒体消息（图片/文件）无文本时生成标注文本，避免空消息进入链路且群日志内容为空。
    const normalized = this.normalizeText(event);
    const messageId = normalized.messageId!;
    const messageService = this.options.messageService;
    const claimed = skipClaim || messageService == null
      ? true
      : await messageService.claimInboundMessage(accountId, { ...normalized, accountId, messageId });
    if (messageService != null && !claimed) return;
    let completed = false;
    try {
      if (normalized.chatType === 'p2p') {
        const named = await this.resolveSenderName(normalized, accountId);
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, named))) {
          await this.options.onUnauthorized?.(accountId, named);
          await this.sendUnauthorized(accountId, named);
        } else if (this.handler.authorizeDirectMessage(accountId, named.senderUnionId ?? named.senderId!, named.text)) {
          const resolvedUserId = await this.options.resolveUserId?.(accountId, named);
          const quotedContext = await this.resolveQuoted(accountId, named);
          const reply = await this.handler.onMessage({ ...named, accountId, maoUserId: resolvedUserId ?? undefined, quotedContext });
          if (reply?.text) await this.sendReply(accountId, named, reply);
        }
        completed = true;
        return;
      }
      if (normalized.chatType !== 'group' || messageService == null) {
        completed = true;
        return;
      }
      const mentioned = this.isBotMentioned(normalized);
      // 群消息立即按到达顺序落日志（占位文本），慢操作（姓名解析/图片预下载）后置为异步富化；
      // 否则图片下载期间后续 @ 触发会先读上下文并推进水位线，该图片将永远无法进入 Agent 会话。
      const logId = await this.runInChatOrder(accountId, normalized.chatId,
        () => messageService.recordGroupMessage(accountId, { ...normalized, accountId }, mentioned));
      if (!mentioned) {
        void this.enrichGroupMessage(accountId, logId, normalized);
        completed = true;
        return;
      }
      const named = await this.resolveSenderName(normalized, accountId);
      void this.enrichGroupMessage(accountId, logId, named);
      if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, named))) {
        await this.options.onUnauthorized?.(accountId, named);
        let sentCard = false;
        try {
          sentCard = await this.options.sendUnauthorizedCard?.(accountId, named) ?? false;
        } catch (error) {
          console.warn(`飞书绑定卡片发送失败，使用文本回退: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!sentCard) await this.sendUnauthorized(accountId, named);
        completed = true;
        return;
      }
      const resolvedUserId = await this.options.resolveUserId?.(accountId, named);
      // 同群内上下文读取排在更早消息的入库之后（runInChatOrder 保序），保证图片等先到消息已可见。
      const group = await this.runInChatOrder(accountId, named.chatId,
        () => messageService.buildGroupContext(accountId, { ...named, accountId, messageId, maoUserId: resolvedUserId ?? undefined }));
      const quotedContext = await this.resolveQuoted(accountId, named);
      const context: FeishuInboundContext = {
        ...named, accountId, messageId, maoUserId: resolvedUserId ?? undefined, groupContext: group.prompt,
        senderLabel: this.options.senderLabel?.(named) ?? defaultSenderLabel(named),
        quotedContext,
      };
      const reply = await this.handler.onMessage(context);
      if (reply?.text) await this.sendReply(accountId, named, reply);
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

  /** 群消息后台富化（不阻塞入库与触发时序）：补齐发送人显示名；图片消息入站预下载，
   * 成功则将日志行占位文本升级为携带 @{路径}@ 引用（Agent 免工具直接读取），失败保留懒加载占位符。 */
  private async enrichGroupMessage(accountId: string, logId: number, event: FeishuNormalizedMessage): Promise<void> {
    try {
      const messageService = this.options.messageService;
      if (messageService == null || event.chatType !== 'group') return;
      const resolved = await this.resolveSenderName(event, accountId);
      if (resolved?.senderName != null && resolved.senderName.trim() !== '') {
        await messageService.updateGroupMessageSenderName(logId, resolved.senderName);
      }
      await this.prewarmGroupImage(accountId, logId, event);
    } catch (error) {
      console.warn(`飞书群消息后台富化失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 群图片预下载：成功回填日志行内容为本地路径引用；失败保留 msg 占位符走 feishu_download_file 懒加载兜底。 */
  private async prewarmGroupImage(accountId: string, logId: number, event: FeishuNormalizedMessage): Promise<void> {
    if (event.messageType !== 'image' || this.options.downloadGroupImage == null) return;
    try {
      const path = await this.options.downloadGroupImage(accountId, event);
      if (path == null || path === '') return;
      // 飞书图片消息无文本，text 此时只可能是懒加载占位符，直接整体替换。
      await this.options.messageService?.updateGroupMessageContent(logId, `[图片已保存: @{${path}}@]`);
    } catch (error) {
      console.warn(`飞书群图片预下载失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private normalizeText(event: FeishuNormalizedMessage): FeishuNormalizedMessage {
    const rawText = event.text?.trim() ?? '';
    if (rawText !== '') return event;
    // 纯文本消息保持原样（空文本不应伪造占位符）；非文本消息统一生成占位/可读文本
    // （复用引用预取的映射，含 post 富文本、语音、视频、卡片等），占位符携带消息 ID，
    // 供 Agent 通过 feishu_download_file 按需下载。
    if (event.messageType === 'text') return event;
    const content: Record<string, unknown> = (event.content ?? {}) as Record<string, unknown>;
    // 归一化事件已提取的 file_name 优先于原始 content（测试与部分消息体可能缺失）。
    const payload = event.fileName != null && content.file_name == null ? { ...content, file_name: event.fileName } : content;
    let placeholder = describeMessageText(
      event.messageType,
      payload,
      event.messageId ?? '未知',
    ).trim();
    if (placeholder === '') placeholder = `[${event.messageType} msg=${event.messageId ?? '未知'}]`;
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
  if (isBotSender(event)) return botSenderLabel(event.senderId);
  const raw = event.rawEvent as Record<string, any>;
  return raw?.event?.sender?.sender_id?.name ?? raw?.event?.sender?.name ?? event.senderId ?? '未知用户';
}

function defaultUnauthorizedText(event: FeishuNormalizedMessage): string {
  return event.chatType === 'group'
    ? '请先完成飞书账号绑定，获得群内使用权限后再试。'
    : '请先完成飞书账号绑定后再试。';
}
