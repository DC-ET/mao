import { randomUUID } from 'node:crypto';
import type { FeishuHarnessService, FeishuInboundContext, FeishuInboundHandler, FeishuReply, CancelFlag, FeishuTaskQueuePort, FeishuQueuePayload, FeishuQueueStoredContext, FeishuInboundQueueRow } from './types.js';
import { CompositeAgentEventListener } from '../harness/core/composite-agent-event-listener.js';
import { FeishuCardProgressListener, type FeishuCardProgress } from './card-progress-listener.js';

export interface FeishuSessionAdapter {
  getOrCreateSession(accountId: string, context: FeishuInboundContext): Promise<{ id: number; workspace?: string | null; executionUserId?: number | null }>;
  /** 保存用户消息。metadata 用于标记该消息与某条队列行的关联（hydrate 判断消息是否已落库）。 */
  saveUserMessage(sessionId: number, content: unknown, metadata?: string | null): Promise<void>;
  getLatestAssistantReply(sessionId: number): Promise<string>;
  /** 执行前重置会话 phase（如 RUNNING），避免上一轮终态（FAILED/CANCELLED）触发 AgentLoop 取消。 */
  updatePhase?(sessionId: number, phase: string): Promise<void>;
  /** 清理取消/失败执行残留的不完整消息尾部，避免污染后续上下文。 */
  cleanupIncompleteTail?(sessionId: number): Promise<number>;
  /** 读取会话当前 phase（DB 层），用于判定会话是否处于 RUNNING/RESUMING（含崩溃恢复中）。 */
  getPhase?(sessionId: number): Promise<string | null>;
}

export interface FeishuMediaDownload {
  images: string[];
  filePaths: string[];
  errors: string[];
}

type FeishuContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string } };

const NOOP_CANCEL_FLAG: CancelFlag = { get: () => false, set: () => undefined };

/** 从入站上下文与构建后的消息组装 payload（用于持久化到队列表）。 */
function buildQueuePayload(botId: number, context: FeishuInboundContext, message: unknown): string {
  const stored: FeishuQueueStoredContext = {
    accountId: context.accountId,
    chatType: context.chatType,
    chatId: context.chatId,
    senderId: context.senderId,
    senderUnionId: context.senderUnionId,
    senderName: context.senderName,
    maoUserId: context.maoUserId,
    messageId: context.messageId,
    senderLabel: context.senderLabel,
    groupContext: context.groupContext,
    quotedContext: context.quotedContext,
  };
  const payload: FeishuQueuePayload = { message, context: stored, botId };
  return JSON.stringify(payload);
}

/** 从队列行重构 FeishuInboundContext（progressCardMessageId 指向排队卡片，供 createProgressCard PATCH 升级）。 */
function reconstructFromQueue(row: FeishuInboundQueueRow): { context: FeishuInboundContext; message: unknown; botId: number } {
  const payload = JSON.parse(row.payload) as FeishuQueuePayload;
  const s = payload.context;
  const context: FeishuInboundContext = {
    eventId: null, messageId: s.messageId, parentId: null, rootId: null,
    chatId: s.chatId, chatType: s.chatType, senderId: s.senderId,
    senderUnionId: s.senderUnionId, senderName: s.senderName, maoUserId: s.maoUserId,
    senderType: 'user', messageType: 'text', imageKey: null, fileKey: null, fileName: null,
    text: '', mentions: [], isBotMentioned: false, content: {}, rawEvent: {},
    accountId: s.accountId, groupContext: s.groupContext, senderLabel: s.senderLabel,
    quotedContext: s.quotedContext,
    progressCardMessageId: row.cardMessageId,
  };
  return { context, message: payload.message, botId: payload.botId };
}

export class AgentFeishuInboundHandler implements FeishuInboundHandler {
  /** 会话级互斥：序列化 busy 检查 + 执行启动的临界区，防止并发 onMessage/drainNext 竞态。 */
  private readonly mutex = new Map<number, Promise<void>>();
  /** 当前正在执行的会话集合。 */
  private readonly busy = new Set<number>();
  /** 当前执行的取消标志（与 agentLoop 共享同一对象引用）。 */
  private readonly cancelFlags = new Map<number, CancelFlag>();
  /** 被按钮「立即发送」中断的会话标记，用于卡片文案区分。 */
  private readonly interrupted = new Set<number>();

  constructor(private readonly options: {
    sessionService: FeishuSessionAdapter;
    harnessService: FeishuHarnessService;
    createCancelFlag?: (sessionId: number) => CancelFlag;
    releaseCancelFlag?: (sessionId: number) => void;
    /** 「立即发送」按钮中断当前执行时的回调（如关闭该会话的 shell）。 */
    onInterruptRunning?: (sessionId: number) => void;
    /** 图片/文件下载：返回 data URI 与落盘路径；返回 null 表示无媒体或未处理。 */
    downloadMedia?: (context: FeishuInboundContext, workspace: string | null) => Promise<FeishuMediaDownload | null>;
    listenerFactory?: (sessionId: number, context: FeishuInboundContext, executionId: string) => Parameters<FeishuHarnessService['execute']>[2] | Promise<Parameters<FeishuHarnessService['execute']>[2]>;
    onExecutionFinished?: (sessionId: number, context: FeishuInboundContext, executionId: string, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>;
    createProgressCard?: (context: FeishuInboundContext, sessionId: number) => Promise<FeishuCardProgress | null>;
    onReply?: (context: FeishuInboundContext, text: string) => Promise<void>;
    // 队列支持
    queueService?: FeishuTaskQueuePort;
    /** 发送排队交互卡片并返回其 message_id（null=发送失败，降级为文本提示）。 */
    createQueueCard?: (context: FeishuInboundContext, queueId: number, sessionId: number) => Promise<string | null>;
    /** botId 解析（accountId → feishu_bot.id）。 */
    resolveBotId?: (accountId: string) => number;
  }) {}

  authorizeDirectMessage(): boolean { return true; }

  /** 中断指定会话的当前执行（由卡片动作服务在「立即发送」时调用）。 */
  interrupt(sessionId: number): void {
    const flag = this.cancelFlags.get(sessionId);
    if (flag != null) flag.set(true);
    this.interrupted.add(sessionId);
    this.options.onInterruptRunning?.(sessionId);
  }

  async onMessage(context: FeishuInboundContext): Promise<FeishuReply | null> {
    const session = await this.options.sessionService.getOrCreateSession(context.accountId, context);
    const sessionId = session.id;
    const message = await this.buildMessage(context, session.workspace ?? null);

    // 忙时立即入队（不等待锁）：同一会话执行中（含崩溃恢复中的 RUNNING/RESUMING），
    // 新消息直接排队并返回，避免持有 inbound claim 阻塞或与恢复任务并发执行。
    if (await this.isBusyOrRecovering(sessionId)) {
      await this.enqueueMessage(sessionId, context, message, session);
      return null;
    }
    // 空闲路径：加锁 + 双重校验后执行；执行期间持有锁，保证 claim 语义与消息保序。
    let executed = false;
    await this.withLock(sessionId, async () => {
      if (await this.isBusyOrRecovering(sessionId)) {
        await this.enqueueMessage(sessionId, context, message, session);
        return;
      }
      this.busy.add(sessionId);
      executed = true;
      // 时序契约：busy.add 必须先于 runExecution 内的 updatePhase(RUNNING)，否则会出现
      // 「phase 已 RUNNING 但 busy 未置位」的窗口，让并发消息误判为空闲而直接执行。
      try {
        await this.executeDirect(sessionId, context, message, session);
      } finally {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
      }
    });
    // 本消息执行结束（或入队后队列需推进）时，尝试接力消费下一个排队任务。
    if (executed) void this.drainNext(sessionId).catch((error) => {
      console.error(`飞书队列消费接力异常, sessionId=${sessionId}`, error);
    });
    return null;
  }

  /** 供 CrashRecoveryRunner 恢复后接力消费：检查是否有排队消息待执行。 */
  async drainNextIfPending(sessionId: number): Promise<void> {
    const queueService = this.options.queueService;
    if (queueService == null) return;
    if (!(await queueService.hasPending(sessionId))) return;
    void this.drainNext(sessionId).catch((error) => {
      console.error(`飞书队列消费异常, sessionId=${sessionId}`, error);
    });
  }

  // ─── 内部：执行路径 ───────────────────────────────────────────────

  private async executeDirect(
    sessionId: number, context: FeishuInboundContext, message: unknown,
    session: { id: number; executionUserId?: number | null },
  ): Promise<void> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    try {
      const reply = await this.runExecution(sessionId, context, message, session.executionUserId ?? context.maoUserId ?? null, cancelFlag);
      if (reply?.text) await this.options.onReply?.(context, reply.text);
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
    }
  }

  private async drainNext(sessionId: number): Promise<void> {
    const queueService = this.options.queueService;
    if (queueService == null) return;
    const claimed = await this.withLock(sessionId, async () => {
      if (await this.isBusyOrRecovering(sessionId)) return false;
      const item = await queueService.claimNext(sessionId);
      if (item == null) return false;
      this.busy.add(sessionId);
      try {
        await this.executeQueued(sessionId, item);
      } finally {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
      }
      return true;
    });
    // 仅当认领到任务时继续接力（队列空则停止，避免无限递归）。
    if (claimed) {
      void this.drainNext(sessionId).catch((error) => {
        console.error(`飞书队列消费接力异常, sessionId=${sessionId}`, error);
      });
    }
  }

  /** 判断会话是否繁忙（内存 busy 或 DB phase 处于 RUNNING/RESUMING，含崩溃恢复中）。 */
  private async isBusyOrRecovering(sessionId: number): Promise<boolean> {
    if (this.busy.has(sessionId)) return true;
    const phase = this.options.sessionService.getPhase == null
      ? null
      : await this.options.sessionService.getPhase(sessionId).catch(() => null);
    return phase === 'RUNNING' || phase === 'RESUMING';
  }

  private async executeQueued(sessionId: number, row: FeishuInboundQueueRow): Promise<void> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    try {
      // reconstructFromQueue 内 JSON.parse 可能抛错：必须置于 try 内，确保 finally 清理队列行。
      const { context, message } = reconstructFromQueue(row);
      const reply = await this.runExecution(sessionId, context, message, row.maoUserId, cancelFlag, row);
      if (reply?.text) await this.options.onReply?.(context, reply.text);
    } catch (error) {
      console.error(`飞书队列消息执行失败, queueId=${row.id}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
      try {
        await this.options.queueService?.complete(row.id);
      } catch (error) {
        console.error(`飞书队列行清理失败, queueId=${row.id}`, error);
      }
    }
  }

  /** 标记「消息已由某条队列行消费」的 metadata 键（写入 message.metadata JSON）。 */
  private static readonly QUEUE_METADATA_KEY = 'feishuQueueId';

  /** 共享执行逻辑：进度卡片 → phase 重置 → 保存消息 → prepare → execute → 结果处理。
   *  返回值 = 待发送的文本回复；返回 null 表示已通过进度卡片呈现（无需再发文本）。
   *  @param queueRow 若为队列消费执行，传入队列行，用于在保存用户消息时写入「消息已被该队列行消费」的标记，
   *                  供启动恢复时判断该消息是否已落库（已落库→删除行由崩溃恢复重放；未落库→复位排队重新消费）。 */
  private async runExecution(
    sessionId: number, context: FeishuInboundContext, message: unknown,
    executionUserId: number | null, cancelFlag: CancelFlag, queueRow?: FeishuInboundQueueRow | null,
  ): Promise<FeishuReply | null> {
    let executionId = '';
    let cardListener: FeishuCardProgressListener | null = null;
    try {
      try {
        const progress = await this.options.createProgressCard?.(context, sessionId) ?? null;
        if (progress != null) cardListener = new FeishuCardProgressListener(progress);
      } catch (error) {
        console.warn(`飞书进度卡片创建失败，继续执行 Agent: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.options.sessionService.updatePhase?.(sessionId, 'RUNNING');
      const metadata = queueRow != null ? JSON.stringify({ [AgentFeishuInboundHandler.QUEUE_METADATA_KEY]: queueRow.id }) : null;
      await this.options.sessionService.saveUserMessage(sessionId, message, metadata);
      const eventId = await this.options.harnessService.prepareMessage(sessionId, message);
      executionId = eventId || '';
      const listener = await this.options.listenerFactory?.(sessionId, context, executionId);
      if (listener == null) throw new Error('Feishu listenerFactory is required to execute a harness session');
      await this.options.harnessService.execute(
        sessionId, eventId || null,
        cardListener == null ? listener : CompositeAgentEventListener.of(listener, cardListener),
        cancelFlag,
        executionUserId,
      );
      if (cancelFlag.get()) {
        const wasInterrupted = this.interrupted.has(sessionId);
        await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
        await cardListener?.cancel(wasInterrupted);
        await this.options.onExecutionFinished?.(sessionId, context, executionId, 'CANCELLED');
        if (cardListener == null) return { text: wasInterrupted ? '任务已被下一条消息中断。' : '任务已取消。' };
        return null;
      }
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      const cardUpdated = await cardListener?.complete(text);
      if (cardListener == null || cardUpdated === false) return { text };
      return null;
    } catch (error) {
      console.error(`飞书 Agent 执行失败, sessionId=${sessionId}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      const cardUpdated = await cardListener?.fail('抱歉，处理您的消息时出现了错误，请稍后再试。');
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'FAILED');
      if (cardListener == null || cardUpdated === false) return { text: '抱歉，处理您的消息时出现了错误，请稍后再试。' };
      return null;
    }
  }

  // ─── 内部：入队 ───────────────────────────────────────────────────

  private async enqueueMessage(
    sessionId: number, context: FeishuInboundContext, message: unknown,
    session: { id: number; executionUserId?: number | null },
  ): Promise<void> {
    const queueService = this.options.queueService;
    if (queueService == null) {
      // 队列未配置：无法排队，回退为文本提示。
      await this.options.onReply?.(context, '当前任务正在执行中，请稍后再发消息。');
      return;
    }
    const botId = this.options.resolveBotId?.(context.accountId) ?? Number(context.accountId);
    const payload = buildQueuePayload(botId, context, message);
    let queueId: number;
    try {
      queueId = await queueService.enqueue({
        sessionId, botId, messageId: context.messageId ?? `no-id-${Date.now()}-${randomUUID()}`,
        senderOpenId: context.senderId ?? '', maoUserId: session.executionUserId ?? context.maoUserId ?? null, payload,
      });
    } catch (error) {
      console.error(`飞书消息入队失败, sessionId=${sessionId}`, error);
      await this.options.onReply?.(context, '当前任务正在执行中，消息排队失败，请稍后重试。');
      return;
    }
    try {
      const cardMessageId = await this.options.createQueueCard?.(context, queueId, sessionId) ?? null;
      if (cardMessageId != null) {
        await queueService.setCardMessageId(queueId, cardMessageId);
      } else {
        // 卡片发送失败：降级文本提示。
        await this.options.onReply?.(context, '当前任务执行中，你的消息已排队等待处理。');
      }
    } catch (error) {
      console.error(`飞书排队卡片发送失败, sessionId=${sessionId}, queueId=${queueId}`, error);
      // 卡片失败不影响入队成功，用户至少有文本提示。
      await this.options.onReply?.(context, '当前任务执行中，你的消息已排队等待处理。');
    }
  }

  // ─── 内部：消息构建（不变） ───────────────────────────────────────

  private async buildMessage(context: FeishuInboundContext, workspace: string | null): Promise<string | FeishuContentPart[]> {
    const isGroup = context.chatType === 'group';
    const senderLabel = context.senderLabel?.trim() || '未知用户';
    const sections: string[] = [];
    const quoted = context.quotedContext?.trim();
    if (quoted != null && quoted !== '') sections.push(`【引用的消息】\n${quoted}`);
    const groupContext = context.groupContext?.trim();
    if (isGroup && groupContext != null && groupContext !== '') sections.push(`【群内最近消息】\n${groupContext}`);
    if (isGroup) {
      sections.push(`【用户消息】\n${senderLabel}：${context.text}`);
    } else {
      sections.push(context.text);
    }
    const text = sections.join('\n\n');
    const media = await this.options.downloadMedia?.(context, workspace) ?? null;
    if (media == null) return text;
    return this.composeContent(text, media);
  }

  private composeContent(text: string, media: FeishuMediaDownload): string | FeishuContentPart[] {
    let body = text;
    if (media.errors.length > 0) {
      const notice = `[以下文件接收失败：${media.errors.join('、')}]`;
      body = body.trim() === '' ? notice : `${body}\n${notice}`;
    }
    if (media.filePaths.length > 0) {
      const refs = media.filePaths.map((path) => `@{${path}}@`).join('\n');
      body = body.trim() === '' ? refs : `${body}\n${refs}`;
    }
    if (media.images.length === 0) return body;
    const parts: FeishuContentPart[] = [{ type: 'text', text: body.trim() === '' ? '请查看图片' : body }];
    for (const uri of media.images) {
      if (uri == null || uri.trim() === '') continue;
      parts.push({ type: 'image_url', imageUrl: { url: uri } });
    }
    return parts;
  }

  // ─── 内部：互斥 ───────────────────────────────────────────────────

  private async withLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutex.set(sessionId, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.mutex.get(sessionId) === current) this.mutex.delete(sessionId);
    }
  }

  private removeCancelFlag(sessionId: number, cancelFlag: CancelFlag): void {
    if (this.cancelFlags.get(sessionId) === cancelFlag) {
      this.cancelFlags.delete(sessionId);
      this.options.releaseCancelFlag?.(sessionId);
    }
  }
}
