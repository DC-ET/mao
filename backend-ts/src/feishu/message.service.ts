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

export interface FeishuThreadSessionResult {
  sessionId: number;
  rootMessageId: string;
  workspace?: string | null;
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
    return this.withChatLock(`${accountId}:${chatId}`, () => this.createConversation(accountId, chatId, context, userId));
  }

  /** 查询私聊当前活跃会话（不动指针、不创建）。 */
  async findActiveP2p(accountId: string, context: FeishuInboundContext, userId?: number): Promise<FeishuConversation | null> {
    return this.repository.findGroupConversation(accountId, p2pChatIdOf(context), userId);
  }

  /**
   * `---` 新建私聊会话：创建新 session 并把活跃指针切到它（chat 级锁内）。
   * 工作区由 sessionFactory 按 `private-{userId}` 固定分配，同一私聊所有会话天然共享根工作区。
   * 返回新会话行；sessionFactory 抛错时向上传播（调用方回复失败提示）。
   * 新会话标记「等待首条消息命名」（持久化，重启安全）。
   */
  async createP2pSession(accountId: string, context: FeishuInboundContext, userId?: number): Promise<FeishuConversation> {
    const chatId = p2pChatIdOf(context);
    return this.withChatLock(`${accountId}:${chatId}`, async () => {
      const session = await this.sessionFactory.create(accountId, context);
      const conversation = await this.repository.saveConversation({ appId: accountId, chatId, sessionId: session.sessionId, ownerUserId: session.ownerUserId, workspace: session.workspace });
      // 标记「等待首条消息命名」。GREATEST 语义下 saveConversation 刚落的 awaiting=0 行会被置 1；
      // 失败仅记日志（会话已建成，命名是体验增强，不应让创建整体报失败）。
      try {
        await this.repository.upsertSessionChannel(session.sessionId, accountId, chatId, 'p2p', true);
      } catch (error) {
        console.warn(`飞书新会话待命名标记失败, sessionId=${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return conversation;
    });
  }

  /**
   * 引用消息自动切换：把活跃指针切到 targetSessionId（chat 级锁内）。
   * 指针行不存在（如未建过会话/换绑后首条消息）或目标与当前相同 → 返回 null（调用方静默）。
   */
  async switchP2pSession(accountId: string, context: FeishuInboundContext, targetSessionId: number, userId?: number): Promise<FeishuConversation | null> {
    const chatId = p2pChatIdOf(context);
    return this.withChatLock(`${accountId}:${chatId}`, async () => {
      const existing = await this.repository.findGroupConversation(accountId, chatId, userId);
      if (existing == null || existing.sessionId === targetSessionId) return null;
      return this.repository.saveConversation({ appId: accountId, chatId, sessionId: targetSessionId, ownerUserId: existing.ownerUserId, workspace: existing.workspace });
    });
  }

  /** 记录私聊消息 → 会话映射（INSERT IGNORE 防重，失败不阻断主流程）。 */
  async recordP2pMessage(accountId: string, messageId: string | null | undefined, sessionId: number, direction: 'IN' | 'OUT'): Promise<void> {
    if (messageId == null || messageId === '') return;
    try {
      await this.repository.recordP2pMessage(accountId, messageId, sessionId, direction);
    } catch (error) {
      console.warn(`飞书私聊消息映射记录失败, appId=${accountId}, messageId=${messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 按飞书消息 ID 查归属会话；查询失败降级为 null（调用方静默保持当前会话）。 */
  async findP2pMessageSession(accountId: string, messageId: string | null | undefined): Promise<number | null> {
    if (messageId == null || messageId === '') return null;
    try {
      return await this.repository.findP2pMessageSession(accountId, messageId);
    } catch (error) {
      console.warn(`飞书私聊消息映射查询失败, appId=${accountId}, messageId=${messageId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 按会话查飞书通道绑定（创建时落行、不可变，活跃指针切换不影响）；查询失败降级 null。 */
  async findSessionChannel(sessionId: number): Promise<{ sessionId: number; appId: string; chatId: string; chatType: 'p2p' | 'group'; awaitingFirstMessageTitle: number } | null> {
    try {
      return await this.repository.findSessionChannel(sessionId);
    } catch (error) {
      console.warn(`飞书会话通道绑定查询失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 清除「等待首条消息命名」标志（命名完成后由装配层调用，失败仅记日志）。 */
  async clearAwaitingFirstMessageTitle(sessionId: number): Promise<void> {
    try {
      await this.repository.clearAwaitingFirstMessageTitle(sessionId);
    } catch (error) {
      console.warn(`清除飞书待命名标志失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 查询会话最新入站消息 ID（用于 reply 发送）；失败降级 null。 */
  async findLatestInboundMessageId(sessionId: number, channel: { appId: string; chatId: string; chatType: 'p2p' | 'group' }): Promise<string | null> {
    try {
      return await this.repository.findLatestInboundMessageId(sessionId, channel);
    } catch (error) {
      console.warn(`查询飞书最新入站消息ID失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 查询话题会话的话题根消息 ID（reply 该 ID 会落入当前话题）；非话题会话或查询失败返回 null。 */
  async findThreadRootMessageId(sessionId: number): Promise<string | null> {
    try {
      const rootMessageId = await this.repository.findThreadRootMessageId(sessionId);
      return rootMessageId != null && rootMessageId !== '' ? rootMessageId : null;
    } catch (error) {
      console.warn(`查询飞书话题根消息ID失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async getOrCreateGroup(accountId: string, context: FeishuInboundContext): Promise<FeishuConversation> {
    if (context.chatId == null) throw new Error('Feishu group message requires chatId');
    const existing = await this.repository.findGroupConversation(accountId, context.chatId);
    if (existing != null) return existing;
    return this.createConversation(accountId, context.chatId, context);
  }

  /** 查询话题→会话映射；未记录返回 null。 */
  async findThreadSession(accountId: string, threadId: string | null | undefined): Promise<{ sessionId: number; rootMessageId: string } | null> {
    if (threadId == null || threadId === '') return null;
    try {
      return await this.repository.findThreadSession(accountId, threadId);
    } catch (error) {
      console.warn(`飞书话题映射查询失败, appId=${accountId}, threadId=${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 获取或创建话题→会话映射。
   * - 映射存在：返回已有会话；
   * - 映射不存在：创建新会话并记录映射。根消息用自身 messageId，回复用 rootId（话题根）作为 rootMessageId。
   *   本方法仅在消息通过 mention 门禁后被调用（@bot 或映射已存在），因此非根消息创建是安全的
   *   （典型场景：先建话题不 @bot，后续在话题内 @bot 触发建会话）。
   */
  async getOrCreateThreadSession(accountId: string, context: FeishuInboundContext): Promise<FeishuThreadSessionResult | null> {
    if (context.threadId == null || context.chatId == null) return null;
    return this.withChatLock(`${accountId}:thread:${context.threadId}`, async () => {
      const existing = await this.repository.findThreadSession(accountId, context.threadId!);
      if (existing != null) {
        const conversation = await this.repository.findGroupConversation(accountId, context.chatId!);
        return { sessionId: existing.sessionId, rootMessageId: existing.rootMessageId, workspace: conversation?.workspace ?? null };
      }
      // rootMessageId：话题根消息用自身 messageId；话题内回复用 rootId（指向话题根的 message_id，
      // reply API 回复该 ID 可自动落入话题）。
      const isRoot = context.parentId == null || context.parentId === '';
      const rootMessageId = isRoot ? context.messageId! : (context.rootId ?? context.parentId ?? context.messageId!);
      const session = await this.sessionFactory.create(accountId, context);
      await this.repository.recordThreadSession({
        appId: accountId, chatId: context.chatId!, threadId: context.threadId!,
        rootMessageId, sessionId: session.sessionId,
      });
      // 话题会话标记待命名（复用 p2p 的持久化标志，首条消息前 20 字命名）。
      try {
        await this.repository.upsertSessionChannel(session.sessionId, accountId, context.chatId!, 'group', true);
      } catch (error) {
        console.warn(`飞书话题会话待命名标记失败, sessionId=${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { sessionId: session.sessionId, rootMessageId, workspace: session.workspace };
    });
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
      threadId: context.threadId ?? null,
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
    const threadId = context.threadId ?? null;
    const messages = await this.repository.listGroupMessages(accountId, context.chatId!, this.contextWindow, this.maxMinutes, threadId);
    // 增量注入：仅注入上次触发之后新增的未 @ 机器人的普通群消息。
    // 已注入的历史随上一轮 USER 消息保存在会话上下文中，重复注入只会浪费 token；
    // @ 机器人的消息本身已作为会话消息保存，同样无需注入。
    // 消息中的文件/图片由 Agent 按需通过 feishu_download_file 工具懒加载，占位文本携带消息 ID。
    const watermark = conversation.lastContextLogId ?? 0;
    const filtered = messages.filter((message) =>
      !message.isMention && message.messageId !== context.messageId && (message.id ?? 0) > watermark);
    // 被窗口淘汰（超出条数上限或时间窗）且从未注入过的更早消息：摘要后一次性注入，避免上下文断层。
    const overflowSection = await this.buildOverflowSummary(accountId, context, conversation, messages, threadId);
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
    threadId: string | null = null,
  ): Promise<string | null> {
    if (this.summarizer == null || recentMessages.length === 0) return null;
    const chatId = context.chatId!;
    const watermark = conversation.lastContextLogId ?? 0;
    const beforeId = Math.min(...recentMessages.map((message) => message.id ?? 0));
    const overflow = await this.repository.listOverflowGroupMessages(accountId, chatId, watermark, beforeId, this.overflowWindow, threadId);
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

  /** chat 级互斥（指针创建/切换/新建的临界区），key 为 `${accountId}:${chatId}`。 */
  private async withChatLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(lockKey, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(lockKey) === queued) this.locks.delete(lockKey);
    }
  }

  private async createConversation(accountId: string, chatId: string, context: FeishuInboundContext, ownerUserId?: number): Promise<FeishuConversation> {
    // 锁内重查同样携带 owner 过滤，避免换绑场景命中旧用户会话。
    const existing = await this.repository.findGroupConversation(accountId, chatId, ownerUserId);
    if (existing != null) return existing;
    const session = await this.sessionFactory.create(accountId, context);
    return this.repository.saveConversation({ appId: accountId, chatId, sessionId: session.sessionId, ownerUserId: session.ownerUserId, workspace: session.workspace });
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
