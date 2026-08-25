import type { FeishuMessageRepository, FeishuConversation, FeishuGroupMessage } from './message.repository.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './types.js';

export interface FeishuSessionFactory {
  create(accountId: string, context: FeishuInboundContext): Promise<{ sessionId: number; ownerUserId: number; workspace?: string | null }>;
}

export interface FeishuGroupContext {
  conversation: FeishuConversation;
  messages: FeishuGroupMessage[];
  prompt: string;
}

export class FeishuMessageService {
  constructor(
    private readonly repository: FeishuMessageRepository,
    private readonly sessionFactory: FeishuSessionFactory,
    private readonly contextWindow = 30,
    private readonly maxMinutes = 120,
  ) {}

  async getOrCreateP2p(accountId: string, context: FeishuInboundContext, userId?: number): Promise<FeishuConversation> {
    const userOpenId = context.senderUnionId ?? context.senderId!;
    // 私聊会话按当前绑定用户隔离：同一 union_id 换绑到其他用户时不会复用原会话/工作区。
    const existing = await this.repository.findP2pConversation(accountId, userOpenId, userId);
    if (existing != null) return existing;
    return this.createConversation(accountId, `p2p:${userOpenId}`, context, userId);
  }

  async getOrCreateGroup(accountId: string, context: FeishuInboundContext): Promise<FeishuConversation> {
    if (context.chatId == null) throw new Error('Feishu group message requires chatId');
    const existing = await this.repository.findGroupConversation(accountId, context.chatId);
    if (existing != null) return existing;
    return this.createConversation(accountId, context.chatId, context);
  }

  async claimInboundMessage(accountId: string, context: FeishuInboundContext): Promise<boolean> {
    if (context.messageId == null || context.messageId === '') return false;
    return this.repository.claimInboundMessage(accountId, context.messageId, context.eventId, context.chatId);
  }

  async releaseInboundMessage(accountId: string, messageId: string): Promise<void> {
    await this.repository.releaseInboundMessage(accountId, messageId);
  }

  async completeInboundMessage(accountId: string, messageId: string): Promise<void> {
    await this.repository.completeInboundMessage(accountId, messageId);
  }

  async recordGroupMessage(accountId: string, context: FeishuInboundContext, isMention: boolean): Promise<number> {
    if (context.chatId == null || context.senderId == null) throw new Error('Feishu group message is missing chat or sender');
    return this.repository.appendGroupMessage({
      appId: accountId, chatId: context.chatId, senderOpenId: context.senderId,
      senderName: senderName(context), content: context.text, messageId: context.messageId,
      isMention, msgType: context.messageType ?? 'text',
      fileKey: context.fileKey ?? context.imageKey ?? null,
    });
  }

  async ensureGroupMember(accountId: string, context: FeishuInboundContext, userId: number): Promise<void> {
    if (context.chatId == null || context.senderId == null) throw new Error('Feishu group message is missing identity');
    await this.repository.addGroupMember(accountId, context.chatId, userId, context.senderId, senderName(context));
  }

  async buildGroupContext(accountId: string, context: FeishuInboundContext): Promise<FeishuGroupContext> {
    const conversation = await this.getOrCreateGroup(accountId, context);
    const messages = await this.repository.listGroupMessages(accountId, context.chatId!, this.contextWindow, this.maxMinutes);
    // 排除触发消息自身（刚写入日志，不应作为群讨论注入上下文）。
    const filtered = context.messageId == null
      ? messages
      : messages.filter((message) => message.messageId !== context.messageId);
    const prompt = filtered.map((message) => `[${formatGroupTime(message.createdAt)}] ${message.senderName}：${message.content ?? ''}`).join('\n');
    return { conversation, messages: filtered, prompt };
  }

  private readonly locks = new Map<string, Promise<void>>();

  private async createConversation(accountId: string, chatId: string, context: FeishuInboundContext, ownerUserId?: number): Promise<FeishuConversation> {
    const lockKey = `${accountId}:${chatId}`;
    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(lockKey, queued);
    await previous;
    try {
      // 锁内重查同样携带 owner 过滤，避免换绑场景命中旧用户会话。
      const existing = await this.repository.findGroupConversation(accountId, chatId, ownerUserId);
      if (existing != null) return existing;
      const session = await this.sessionFactory.create(accountId, context);
      return this.repository.saveConversation({ appId: accountId, chatId, sessionId: session.sessionId, ownerUserId: session.ownerUserId, workspace: session.workspace });
    } finally {
      release();
      if (this.locks.get(lockKey) === queued) this.locks.delete(lockKey);
    }
  }
}

function senderName(context: FeishuNormalizedMessage): string {
  const raw = context.rawEvent as Record<string, any>;
  const mentions: any[] = raw?.event?.message?.mentions ?? raw?.message?.mentions ?? [];
  const self = mentions.find((item) => (item?.id?.open_id ?? item?.key) === context.senderId);
  if (self?.name) return String(self.name);
  const name = raw?.event?.sender?.sender_id?.name ?? raw?.sender?.sender_id?.name;
  return name ?? context.senderId ?? '未知用户';
}

/** createdAt 为 'YYYY-MM-DD HH:mm:ss'，取 HH:mm。 */
function formatGroupTime(createdAt?: string | null): string {
  if (createdAt == null || createdAt.length < 16) return '--:--';
  return createdAt.slice(11, 16);
}

export { senderName, formatGroupTime };
