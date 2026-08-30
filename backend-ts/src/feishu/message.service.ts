import type { FeishuMessageRepository, FeishuConversation, FeishuGroupMessage } from './message.repository.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './types.js';
import type { GroupContextSummarizer } from './group-context-summarizer.js';

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
    private readonly contextWindow = 20,
    private readonly maxMinutes = 120,
    private readonly summarizer: GroupContextSummarizer | null = null,
    private readonly overflowWindow = 100,
  ) {}

  async getOrCreateP2p(accountId: string, context: FeishuInboundContext, userId?: number): Promise<FeishuConversation> {
    const chatId = p2pChatIdOf(context);
    // 私聊会话按当前绑定用户隔离：同一身份换绑到其他用户时不会复用原会话/工作区。
    const existing = await this.repository.findGroupConversation(accountId, chatId, userId);
    if (existing != null) return existing;
    return this.createConversation(accountId, chatId, context, userId);
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
      fileName: context.fileName ?? null,
    });
  }

  /** 回填群消息行内容（图片预下载完成后的本地路径引用等）。 */
  async updateGroupMessageContent(logId: number, content: string): Promise<void> {
    await this.repository.updateGroupMessageContent(logId, content);
  }

  /** 回填群消息行发送人显示名。 */
  async updateGroupMessageSenderName(logId: number, senderName: string): Promise<void> {
    await this.repository.updateGroupMessageSenderName(logId, senderName);
  }

  async buildGroupContext(accountId: string, context: FeishuInboundContext): Promise<FeishuGroupContext> {
    const conversation = await this.getOrCreateGroup(accountId, context);
    const messages = await this.repository.listGroupMessages(accountId, context.chatId!, this.contextWindow, this.maxMinutes);
    // 增量注入：仅注入上次触发之后新增的未 @ 机器人的普通群消息。
    // 已注入的历史随上一轮 USER 消息保存在会话上下文中，重复注入只会浪费 token；
    // @ 机器人的消息本身已作为会话消息保存，同样无需注入。
    // 消息中的文件/图片由 Agent 按需通过 feishu_download_file 工具懒加载，占位文本携带消息 ID。
    const watermark = conversation.lastContextLogId ?? 0;
    const filtered = messages.filter((message) =>
      !message.isMention && message.messageId !== context.messageId && (message.id ?? 0) > watermark);
    // 被窗口淘汰（超出条数上限或时间窗）且从未注入过的更早消息：摘要后一次性注入，避免上下文断层。
    const overflowSection = await this.buildOverflowSummary(accountId, context, conversation, messages);
    const lines = filtered.map((message) => `[${formatGroupTime(message.createdAt)}] ${message.senderName}：${message.content ?? ''}`);
    const prompt = [...(overflowSection != null ? [overflowSection] : []), ...lines].join('\n');
    const maxLogId = messages.reduce((acc, message) => Math.max(acc, message.id ?? 0), watermark);
    if (maxLogId > watermark) {
      await this.repository.updateGroupContextWatermark(accountId, context.chatId!, maxLogId);
    }
    return { conversation, messages: filtered, prompt };
  }

  /** 溢出摘要：取注入窗口边界之前、水位线之后的未注入普通消息（最多 overflowWindow 条，不限时间），
   *  LLM 摘要后放在最近消息之前。结果缓存于会话行；摘要失败降级为不注入，不阻塞触发链路。 */
  private async buildOverflowSummary(
    accountId: string, context: FeishuInboundContext,
    conversation: FeishuConversation, recentMessages: FeishuGroupMessage[],
  ): Promise<string | null> {
    if (this.summarizer == null || recentMessages.length === 0) return null;
    const chatId = context.chatId!;
    const watermark = conversation.lastContextLogId ?? 0;
    const beforeId = Math.min(...recentMessages.map((message) => message.id ?? 0));
    const overflow = await this.repository.listOverflowGroupMessages(accountId, chatId, watermark, beforeId, this.overflowWindow);
    if (overflow.length === 0) return null;
    const maxOverflowId = Math.max(...overflow.map((message) => message.id ?? 0));
    const cached = conversation.contextSummary?.trim();
    if (cached != null && cached !== '' && (conversation.contextSummaryLogId ?? 0) >= maxOverflowId) {
      return `[更早历史消息摘要]\n${cached}`;
    }
    const record = renderOverflowRecord(overflow);
    if (record === '') return null;
    // L-3：渲染可能因超长丢弃最旧行，记账水位必须以「实际参与摘要的最大消息 id」为准，
    // 否则被丢弃的最旧消息既不会增量注入、也永远进不了溢出查询，永久丢失于上下文。
    const keptMaxId = keptMaxOverflowId(overflow, record);
    const summary = await this.summarizer.summarize(record, conversation.sessionId);
    if (summary == null || summary.trim() === '') return null;
    const trimmed = summary.trim();
    await this.repository.updateGroupContextSummary(accountId, chatId, trimmed, keptMaxId > 0 ? keptMaxId : maxOverflowId);
    return `[更早历史消息摘要]\n${trimmed}`;
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
  if (context.senderName != null && context.senderName.trim() !== '') return context.senderName;
  if (isBotSender(context)) return botSenderLabel(context.senderId);
  const raw = context.rawEvent as Record<string, any>;
  const mentions: any[] = raw?.event?.message?.mentions ?? raw?.message?.mentions ?? [];
  const self = mentions.find((item) => (item?.id?.open_id ?? item?.key) === context.senderId);
  if (self?.name) return String(self.name);
  const name = raw?.event?.sender?.sender_id?.name ?? raw?.sender?.sender_id?.name;
  return name ?? context.senderId ?? '未知用户';
}

/** 消息发送者是否为机器人（应用）：receive_v1 事件 sender_type 实际取值 app，部分事件文档为 bot，两者都识别。 */
function isBotSender(context: { senderType?: string | null }): boolean {
  const type = context.senderType?.trim().toLowerCase();
  return type === 'app' || type === 'bot';
}

/** 机器人发送者统一显示名：飞书不提供跨应用机器人名称的查询能力，用「机器人_」+ id 前 8 位区分。 */
function botSenderLabel(senderId: string | null | undefined): string {
  const bare = (senderId ?? '').replace(/^ou_/, '');
  return `机器人_${bare.slice(0, 8)}`;
}

/** createdAt 为 'YYYY-MM-DD HH:mm:ss'（库内本地时间），取 'YYYY-MM-DD HH:mm' 避免跨日丢失年月日。 */
function formatGroupTime(createdAt?: string | null): string {
  if (createdAt == null || createdAt.length < 16) return '--:--';
  return createdAt.slice(0, 16);
}

/** 溢出消息渲染为摘要输入：与注入格式一致；单条截断防超长，总量超限时优先保留最近的行。 */
function renderOverflowRecord(messages: FeishuGroupMessage[]): string {
  const maxContentChars = 200;
  const maxTotalChars = 16000;
  const lines = messages.map((message) => {
    const content = message.content ?? '';
    const trimmed = content.length > maxContentChars ? `${content.slice(0, maxContentChars)}…` : content;
    return `[${formatGroupTime(message.createdAt)}] ${message.senderName}：${trimmed}`;
  });
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxTotalChars) break;
    kept.unshift(lines[i]);
  }
  return kept.join('\n');
}

/** 被 renderOverflowRecord 实际保留（未因超长丢弃）的消息中最大的 id；0 表示无法判定。 */
function keptMaxOverflowId(messages: FeishuGroupMessage[], rendered: string): number {
  // 渲染为空 → 无保留；否则取 messages 中最后一个能「复原」到 rendered 的行近似——
  // 更稳妥做法：按与渲染相同的保留策略逆推（保留尾部直到总长超限）。
  if (rendered.trim() === '') return 0;
  const maxContentChars = 200;
  const maxTotalChars = 16000;
  const lines = messages.map((message) => {
    const content = message.content ?? '';
    const trimmed = content.length > maxContentChars ? `${content.slice(0, maxContentChars)}…` : content;
    return `[${formatGroupTime(message.createdAt)}] ${message.senderName}：${trimmed}`;
  });
  let total = 0;
  let keptMax = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxTotalChars) break;
    const id = messages[i]?.id ?? 0;
    if (id > keptMax) keptMax = id;
  }
  return keptMax;
}

export { senderName, isBotSender, botSenderLabel, formatGroupTime, p2pChatIdOf };

/** 私聊会话键：身份形态在建会话时确定并编码进前缀，发送侧据此直接解析 receiveIdType（见 feishuSendTargetOf）。 */
function p2pChatIdOf(context: FeishuInboundContext): string {
  const unionId = context.senderUnionId ?? '';
  return unionId !== '' ? `p2p:union:${unionId}` : `p2p:open:${context.senderId ?? ''}`;
}
