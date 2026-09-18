import { randomUUID } from 'node:crypto';
import type { FeishuHarnessService, FeishuInboundContext, FeishuInboundHandler, FeishuReply, CancelFlag, FeishuTaskQueuePort, FeishuQueuePayload, FeishuQueueStoredContext, FeishuInboundQueueRow } from './types.js';
import type { StreamingWsRegistry } from '../session/ws/streaming-ws-registry.js';
import { userMessagePayloadOf } from '../session/ws/streaming-ws-handler.js';
import { wsEvent } from '../session/ws/ws-event.js';
import { CompositeAgentEventListener } from '../harness/core/composite-agent-event-listener.js';
import { NoopAgentEventListener } from '../harness/core/agent-event-listener.js';
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
  /** 图片 data URI（多模态直传模型）。 */
  images: string[];
  /** 图片落盘路径（{workspace}/chat-files/{日期}/，供 Agent 工具二次读取）。 */
  imagePaths: string[];
  filePaths: string[];
  errors: string[];
}

/** 私聊多会话控制端口：活跃指针查询/新建/切换、消息→会话映射、新会话命名。 */
export interface FeishuP2pSessionControl {
  /** 当前活跃会话（不创建）；null=尚未建会话。 */
  findActiveSession(accountId: string, context: FeishuInboundContext): Promise<{ id: number } | null>;
  /** `---` 新建会话：创建 session 并把活跃指针切到它，返回新会话。 */
  createSession(accountId: string, context: FeishuInboundContext): Promise<{ id: number }>;
  /** 引用切换：把活跃指针切到目标会话；指针行不存在或目标即当前 → null。 */
  switchSession(accountId: string, context: FeishuInboundContext, targetSessionId: number): Promise<{ id: number } | null>;
  /** 按飞书消息 ID 查归属会话；未记录返回 null。 */
  findSessionByMessageId(accountId: string, messageId: string): Promise<number | null>;
  /** 记录消息 → 会话映射（INSERT IGNORE 防重，内部容错不抛）。 */
  recordMessageMapping(accountId: string, messageId: string | null | undefined, sessionId: number, direction: 'IN' | 'OUT'): Promise<void>;
  /** 新会话首条消息命名（持久化待命名标志驱动，非新会话/已命名时为 no-op）。 */
  finalizeNewSessionTitle?(sessionId: number, title: string): Promise<boolean>;
}

/** 话题会话控制端口：话题→会话映射查询/创建。 */
export interface FeishuThreadSessionControl {
  /** 查询话题→会话映射；未记录返回 null（不创建）。 */
  findSession(accountId: string, context: FeishuInboundContext): Promise<{ sessionId: number; rootMessageId: string } | null>;
  /** 获取或创建话题→会话映射：映射存在返回已有；不存在且为话题根消息创建新会话；非根消息返回 null。 */
  getOrCreateSession(accountId: string, context: FeishuInboundContext): Promise<{ sessionId: number; rootMessageId: string; workspace?: string | null; executionUserId?: number | null } | null>;
}

/** `---` 新建会话指令：trim 后为 3 个及以上半角连字符或全角破折号的宽松变体集合。 */
export function isNewSessionCommand(text: string | null | undefined): boolean {
  return /^[-—]{3,}$/u.test((text ?? '').trim());
}

const NEW_SESSION_CONFIRM_TEXT = '已开启新会话，后续消息将在新的上下文中处理。';
const SWITCH_SESSION_CONFIRM_TEXT = '已切换到该消息所在的会话，后续消息将以该会话上下文为准。';
const NEW_SESSION_FAILED_TEXT = '开启新会话失败，请稍后再试。';
const NEW_SESSION_TITLE_MAX_CHARS = 20;

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
    threadId: context.threadId,
    parentId: context.parentId,
    rootId: context.rootId,
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
    eventId: null, messageId: s.messageId, parentId: s.parentId ?? null, rootId: s.rootId ?? null, threadId: s.threadId ?? null,
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
  /** p2p chat 级互斥：序列化指令判定→指针切换→归属确定的临界区（key = accountId:sender）。 */
  private readonly p2pChatMutex = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    sessionService: FeishuSessionAdapter;
    harnessService: FeishuHarnessService;
    /** 多端同步：用户消息落库后按执行归属用户广播 user_message_saved（未配置时跳过）。 */
    registry?: StreamingWsRegistry;
    createCancelFlag?: (sessionId: number) => CancelFlag;
    releaseCancelFlag?: (sessionId: number) => void;
    /** 「立即发送」按钮中断当前执行时的回调（如关闭该会话的 shell、置位 AgentLoop 取消标志）。 */
    onInterruptRunning?: (sessionId: number) => void;
    /**
     * 内存中没有正在执行的任务（典型：崩溃恢复尚未/未能挂上 cancel flag，DB 仍为 RUNNING）时，
     * 先把会话落成 CANCELLED 再排空队列，避免飞书「取消/立即发送」空转、任务永久卡住。
     */
    resolveIdleRunning?: (sessionId: number) => Promise<void>;
    /** 图片/文件下载：返回 data URI 与落盘路径；返回 null 表示无媒体或未处理。 */
    downloadMedia?: (context: FeishuInboundContext, workspace: string | null) => Promise<FeishuMediaDownload | null>;
    listenerFactory?: (sessionId: number, context: FeishuInboundContext, executionId: string) => Parameters<FeishuHarnessService['execute']>[2] | Promise<Parameters<FeishuHarnessService['execute']>[2]>;
    onExecutionFinished?: (sessionId: number, context: FeishuInboundContext, executionId: string, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>;
    createProgressCard?: (context: FeishuInboundContext, sessionId: number) => Promise<FeishuCardProgress | null>;
    // 队列支持
    queueService?: FeishuTaskQueuePort;
    /** 发送排队交互卡片并返回其 message_id（null=发送失败，降级为文本提示）。 */
    createQueueCard?: (context: FeishuInboundContext, queueId: number, sessionId: number) => Promise<string | null>;
    /** botId 解析（accountId → feishu_bot.id）。 */
    resolveBotId?: (accountId: string) => number;
    /** 私聊多会话控制（未配置时 `---`/引用切换不生效，行为与旧版一致）。 */
    p2pSessionControl?: FeishuP2pSessionControl;
    /** 话题会话控制（未配置时话题消息走现有群逻辑）。 */
    threadSessionControl?: FeishuThreadSessionControl;
    /** 文本回复发送：成功返回飞书 message_id（供出站映射），失败返回 null（内部可抛错，由 reply 统一容错）。 */
    onReply?: (context: FeishuInboundContext, text: string, sessionId?: number) => Promise<string | null>;
  }) {}

  authorizeDirectMessage(): boolean { return true; }

  /** 中断指定会话的当前执行（由卡片动作服务在「立即发送」时调用）。返回是否命中本 handler 的执行。 */
  interrupt(sessionId: number): boolean {
    const flag = this.cancelFlags.get(sessionId);
    if (flag != null) {
      flag.set(true);
      this.interrupted.add(sessionId);
    }
    // 崩溃恢复续跑走 AgentLoop flag，不在本 handler 的 cancelFlags 里；shell / AgentLoop 取消仍要发。
    this.options.onInterruptRunning?.(sessionId);
    return flag != null;
  }

  /**
   * 进度卡「取消任务」：只置取消标志，不写 interrupted 标记——
   * interrupted 语义是「被下一条指令插队中断」，用户主动取消应显示「任务已取消」。
   */
  cancel(sessionId: number): boolean {
    const flag = this.cancelFlags.get(sessionId);
    if (flag != null) flag.set(true);
    this.options.onInterruptRunning?.(sessionId);
    return flag != null;
  }

  /**
   * 失败卡「重试」：与桌面端同语义——清理未完成尾巴，基于会话历史续跑（不插入新用户消息）。
   * 仅 await 完成「取卡 → 置 busy → 起跑」，实际 execute 后台续跑——飞书卡片回调须在数秒内返回 RUNNING 卡。
   * @param createProgress 为点击的那张失败卡创建可续更的 progress 闭包（PATCH 原卡片）。
   */
  async retryExecution(
    sessionId: number,
    createProgress: () => Promise<FeishuCardProgress | null>,
  ): Promise<{ ok: true } | { ok: false; reason: 'BUSY' | 'NOT_FAILED' | 'NO_PROGRESS' }> {
    if (this.busy.has(sessionId)) return { ok: false, reason: 'BUSY' };
    const phase = await this.options.sessionService.getPhase?.(sessionId).catch(() => null);
    if (phase != null && phase !== 'FAILED') return { ok: false, reason: 'NOT_FAILED' };
    let outcome: { ok: true } | { ok: false; reason: 'BUSY' | 'NOT_FAILED' | 'NO_PROGRESS' } = { ok: false, reason: 'BUSY' };
    await this.withLock(sessionId, async () => {
      if (await this.isBusyOrRecovering(sessionId)) return;
      this.busy.add(sessionId);
      let progress: FeishuCardProgress | null = null;
      try {
        progress = await createProgress().catch(() => null);
      } catch {
        progress = null;
      }
      if (progress == null) {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
        outcome = { ok: false, reason: 'NO_PROGRESS' };
        return;
      }
      outcome = { ok: true };
      // 不阻塞锁与回调：runRetry 自己收尾 busy / cancelFlag。
      void this.runRetry(sessionId, progress)
        .catch((error) => {
          console.error(`飞书重试后台执行未捕获异常, sessionId=${sessionId}`, error);
        })
        .finally(() => {
          this.busy.delete(sessionId);
          this.interrupted.delete(sessionId);
        });
    });
    return outcome;
  }

  /** 重试执行主体：不 saveUserMessage / prepareMessage，直接 execute 续跑历史。 */
  private async runRetry(sessionId: number, progress: FeishuCardProgress): Promise<void> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    let executionId = '';
    let cardListener: FeishuCardProgressListener | null = null;
    const stubContext = {
      accountId: '0', chatType: 'unknown', chatId: null, senderId: null, senderUnionId: null,
      messageId: null, senderType: 'user', messageType: 'text', text: '', mentions: [],
      isBotMentioned: false, content: {}, rawEvent: {}, eventId: null,
    } as unknown as FeishuInboundContext;
    try {
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      await this.options.sessionService.updatePhase?.(sessionId, 'RUNNING');
      cardListener = new FeishuCardProgressListener(progress);
      // 立刻把原失败卡刷成执行中，避免用户点击后卡片仍停留在失败态。
      try {
        await progress.update('RUNNING', 0, '正在重试，请稍候…', []);
      } catch (error) {
        console.warn(`飞书重试进度卡片首次 PATCH 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      executionId = randomUUID();
      const listener = await this.options.listenerFactory?.(sessionId, stubContext, executionId)
        ?? new NoopAgentEventListener();
      await this.options.harnessService.execute(
        sessionId, null,
        CompositeAgentEventListener.of(listener, cardListener),
        cancelFlag,
      );
      if (cancelFlag.get()) {
        const wasInterrupted = this.interrupted.has(sessionId);
        await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
        await cardListener.cancel(wasInterrupted);
        await this.options.onExecutionFinished?.(sessionId, stubContext, executionId, 'CANCELLED');
        return;
      }
      await this.options.onExecutionFinished?.(sessionId, stubContext, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      const cardUpdated = await cardListener.complete(text);
      if (cardUpdated === false && text != null && text !== '') {
        await this.reply(stubContext, text, sessionId).catch(() => undefined);
      }
    } catch (error) {
      console.error(`飞书重试执行失败, sessionId=${sessionId}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      const failText = feishuFailureText(error);
      const cardUpdated = await cardListener?.fail(failText);
      await this.options.onExecutionFinished?.(sessionId, stubContext, executionId, 'FAILED');
      if ((cardListener == null || cardUpdated === false) && failText !== '') {
        await this.reply(stubContext, failText, sessionId).catch(() => undefined);
      }
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
    }
  }

  /**
   * M-6：插队按钮的「中断 + 接力」原子路径。
   * - 命中当前执行：置取消标志，并在下一条消息/队列接力时机由 onExecutionFinished/onMessage 驱动；
   * - 未命中（会话已空闲或仅 DB 残留 RUNNING）：先 resolveIdleRunning 落 CANCELLED，再排空，
   *   避免重启后飞书「立即发送」空转、排队消息永久滞留。
   */
  interruptAndDrain(sessionId: number): void {
    const hitInbound = this.interrupt(sessionId);
    if (hitInbound) {
      void this.drainNextIfPending(sessionId).catch((error) => {
        console.error(`飞书插队后排空异常, sessionId=${sessionId}`, error);
      });
      return;
    }
    const resolveIdle = this.options.resolveIdleRunning;
    if (resolveIdle == null) {
      void this.drainNextIfPending(sessionId).catch((error) => {
        console.error(`飞书插队后排空异常, sessionId=${sessionId}`, error);
      });
      return;
    }
    void resolveIdle(sessionId).then(() => this.drainNextIfPending(sessionId)).catch((error) => {
      console.error(`飞书插队后排空异常, sessionId=${sessionId}`, error);
    });
  }

  async onMessage(context: FeishuInboundContext): Promise<FeishuReply | null> {
    if (context.chatType === 'p2p' && this.options.p2pSessionControl != null) {
      return this.onP2pMessage(context);
    }
    return this.onGroupMessage(context);
  }

  /**
   * p2p 入站：chat 级锁内完成「指令判定 → 指针切换/新建 → 会话归属确定 + 映射记录」，
   * 保证同一用户的消息按到达顺序归属（并发下不会出现后发消息读到旧指针）。
   * 执行/入队在锁外按 sessionId 粒度互斥，旧会话执行不阻塞新会话消息（允许并行）。
   */
  private async onP2pMessage(context: FeishuInboundContext): Promise<FeishuReply | null> {
    const outcome = await this.withP2pChatLock(context, () => this.resolveP2pInbound(context));
    if (outcome.confirm != null) {
      await this.reply(context, outcome.confirm.text, outcome.confirm.sessionId ?? undefined);
    }
    if (outcome.intercepted) return null;
    return this.executeWithSession(outcome.session!, context);
  }

  /** p2p 临界区：只做 DB 决策与映射记录，网络发送（确认文案）由调用方在锁外执行。 */
  private async resolveP2pInbound(context: FeishuInboundContext): Promise<{
    intercepted: boolean;
    confirm?: { text: string; sessionId: number | null };
    session?: { id: number; workspace?: string | null; executionUserId?: number | null };
  }> {
    const control = this.options.p2pSessionControl!;
    const accountId = context.accountId;
    // 1) `---` 新建会话：创建新 session + 指针切换 + 拦截本消息（不入会话消息流）。
    if (isNewSessionCommand(context.text)) {
      try {
        const created = await control.createSession(accountId, context);
        await control.recordMessageMapping(accountId, context.messageId, created.id, 'IN');
        return { intercepted: true, confirm: { text: NEW_SESSION_CONFIRM_TEXT, sessionId: created.id } };
      } catch (error) {
        console.error(`飞书私聊新建会话失败, accountId=${accountId}, messageId=${context.messageId}`, error);
        return { intercepted: true, confirm: { text: NEW_SESSION_FAILED_TEXT, sessionId: null } };
      }
    }
    // 2) 引用切换：parentId 查映射定位归属会话；命中且 ≠ 当前活跃 → 切指针并回复确认；
    //    未命中（历史消息/跨聊天/映射缺失）→ 静默保持当前会话，仅记日志。
    let confirm: { text: string; sessionId: number } | null = null;
    if (context.parentId != null && context.parentId !== '') {
      const targetSessionId = await control.findSessionByMessageId(accountId, context.parentId);
      if (targetSessionId != null) {
        const active = await control.findActiveSession(accountId, context);
        if (active == null) {
          console.warn(`飞书引用切换跳过: 活跃会话不存在, appId=${accountId}, parentId=${context.parentId}, target=${targetSessionId}`);
        } else if (active.id === targetSessionId) {
          // 已在目标会话：静默。
        } else {
          const switched = await control.switchSession(accountId, context, targetSessionId);
          if (switched != null) {
            console.info(`飞书引用切换会话, appId=${accountId}, ${active.id} -> ${targetSessionId}, messageId=${context.messageId}`);
            confirm = { text: SWITCH_SESSION_CONFIRM_TEXT, sessionId: switched.id };
            // 不提前返回：继续走正常路径取会话行（workspace）并记录映射。
          }
        }
      }
    }
    // 3) 正常路径：指针会话（可能已被上面切换）→ 记录入站映射 → 新会话首条消息命名。
    const session = await this.options.sessionService.getOrCreateSession(accountId, context);
    await control.recordMessageMapping(accountId, context.messageId, session.id, 'IN');
    await this.renameNewP2pSessionIfNeeded(session.id, context);
    return { intercepted: false, ...(confirm != null ? { confirm } : {}), session };
  }

  /** 新会话首条消息命名：取消息文本前 20 字（由持久化待命名标志驱动，非新会话为 no-op）。 */
  private async renameNewP2pSessionIfNeeded(sessionId: number, context: FeishuInboundContext): Promise<void> {
    const finalize = this.options.p2pSessionControl?.finalizeNewSessionTitle;
    if (finalize == null) return;
    const text = context.text?.trim() ?? '';
    if (text === '') return;
    const title = text.length > NEW_SESSION_TITLE_MAX_CHARS ? text.slice(0, NEW_SESSION_TITLE_MAX_CHARS) : text;
    try {
      await finalize(sessionId, title);
    } catch (error) {
      console.warn(`飞书新会话命名失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 群聊入站：话题分支 + 现有逻辑。话题消息优先路由到话题会话；映射未命中降级走现有群逻辑。 */
  private async onGroupMessage(context: FeishuInboundContext): Promise<FeishuReply | null> {
    // 话题路径：threadId 存在且话题会话控制已配置。
    if (context.threadId != null && this.options.threadSessionControl != null) {
      try {
        const threadSession = await this.options.threadSessionControl.getOrCreateSession(context.accountId, context);
        if (threadSession != null) {
          const session = { id: threadSession.sessionId, workspace: threadSession.workspace ?? null, executionUserId: threadSession.executionUserId ?? context.maoUserId ?? null };
          // 首条消息命名：新建话题会话标记了 awaitingFirstMessageTitle，此处用消息前 20 字重命名。
          await this.renameNewP2pSessionIfNeeded(session.id, context);
          return this.executeWithSession(session, context);
        }
        // 映射未命中且非话题根消息（上线前话题的回复）→ 降级走现有群逻辑。
      } catch (error) {
        console.error(`飞书话题会话获取失败, accountId=${context.accountId}, threadId=${context.threadId}`, error);
        // 降级走现有群逻辑。
      }
    }
    // 现有逻辑：群级单会话。
    const session = await this.options.sessionService.getOrCreateSession(context.accountId, context);
    return this.executeWithSession(session, context);
  }

  /** 共享执行路径：buildMessage → busy 检查/入队/执行（按 sessionId 粒度互斥）。 */
  private async executeWithSession(
    session: { id: number; workspace?: string | null; executionUserId?: number | null },
    context: FeishuInboundContext,
  ): Promise<FeishuReply | null> {
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
    let phase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED';
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
        phase = await this.executeDirect(sessionId, context, message, session);
      } finally {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
      }
    });
    // 本消息执行结束（或入队后队列需推进）时，尝试接力消费下一个排队任务；
    // 上一任务 FAILED 时不再自动消费下一条（延续失败上下文执行会产生不可信结果）。
    if (executed && phase !== 'FAILED') void this.drainNext(sessionId).catch((error) => {
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
  ): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED'> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    try {
      const result = await this.runExecution(sessionId, context, message, session.executionUserId ?? context.maoUserId ?? null, cancelFlag);
      // 回复发送失败不影响执行终态：任务已完成，队列仍应按 result.phase 决策是否接力。
      if (result.text) {
        await this.reply(context, result.text, sessionId);
      }
      return result.phase;
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
    }
  }

  private async drainNext(sessionId: number): Promise<void> {
    const queueService = this.options.queueService;
    if (queueService == null) return;
    const phase = await this.withLock(sessionId, async () => {
      if (await this.isBusyOrRecovering(sessionId)) return null;
      const item = await queueService.claimNext(sessionId);
      if (item == null) return null;
      this.busy.add(sessionId);
      try {
        return await this.executeQueued(sessionId, item);
      } finally {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
      }
    });
    // 仅当认领到任务且本轮执行未失败时继续接力（队列空则停止，避免无限递归；
    // 失败则停止自动消费下一条，避免基于失败上下文继续执行）。
    if (phase != null && phase !== 'FAILED') {
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

  private async executeQueued(sessionId: number, row: FeishuInboundQueueRow): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED'> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    let phase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED';
    try {
      // reconstructFromQueue 内 JSON.parse 可能抛错：必须置于 try 内，确保 finally 清理队列行。
      const { context, message } = reconstructFromQueue(row);
      const result = await this.runExecution(sessionId, context, message, row.maoUserId, cancelFlag, row);
      phase = result.phase;
      // 回复发送失败不影响执行终态：queueRow 仍会清理，且不把执行成功误判为 FAILED 而暂停队列。
      if (result.text) {
        try {
          await this.reply(context, result.text, sessionId);
        } catch (error) {
          console.error(`飞书队列回复发送失败, queueId=${row.id}`, error);
        }
      }
    } catch (error) {
      console.error(`飞书队列消息执行失败, queueId=${row.id}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      phase = 'FAILED';
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
      try {
        await this.options.queueService?.complete(row.id);
      } catch (error) {
        console.error(`飞书队列行清理失败, queueId=${row.id}`, error);
      }
    }
    return phase;
  }

  /** 标记「消息已由某条队列行消费」的 metadata 键（写入 message.metadata JSON）。 */
  private static readonly QUEUE_METADATA_KEY = 'feishuQueueId';

  /** 共享执行逻辑：进度卡片 → phase 重置 → 保存消息 → prepare → execute → 结果处理。
   *  返回 `{ text, phase }`：text = 待发送的文本回复（null 表示已通过进度卡片呈现，无需再发文本）；
   *  phase = 本次执行的终态，供调用方决定队列是否接力消费（FAILED 时不消费下一条）。
   *  @param queueRow 若为队列消费执行，传入队列行，用于在保存用户消息时写入「消息已被该队列行消费」的标记，
   *                  供启动恢复时判断该消息是否已落库（已落库→删除行由崩溃恢复重放；未落库→复位排队重新消费）。 */
  private async runExecution(
    sessionId: number, context: FeishuInboundContext, message: unknown,
    executionUserId: number | null, cancelFlag: CancelFlag, queueRow?: FeishuInboundQueueRow | null,
  ): Promise<{ text: string | null; phase: 'COMPLETED' | 'CANCELLED' | 'FAILED' }> {
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
      const messageForEcho = message;
      await this.options.sessionService.saveUserMessage(sessionId, message, metadata);
      // 多端同步：飞书通道落库的用户消息同步广播给该用户所有已连接端（桌面/Web/安卓），
      // content/images 由统一提取器解析，桌面端按 messageId 去重后回显。
      if (executionUserId != null) {
        const payload = userMessagePayloadOf(messageForEcho);
        this.options.registry?.send(executionUserId, wsEvent('user_message_saved', sessionId, {
          messageId: null,
          source: 'feishu',
          tempEventId: '',
          content: payload.content,
          ...(payload.images.length > 0 ? { images: payload.images } : {}),
        }));
      }
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
        const text = cardListener == null ? (wasInterrupted ? '任务已被下一条消息中断。' : '任务已取消。') : null;
        return { text, phase: 'CANCELLED' };
      }
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      const cardUpdated = await cardListener?.complete(text);
      const replyText = cardListener == null || cardUpdated === false ? text : null;
      return { text: replyText, phase: 'COMPLETED' };
    } catch (error) {
      console.error(`飞书 Agent 执行失败, sessionId=${sessionId}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      // 与客户端 ExecutionErrorBanner 一致：透传具体 error.message，便于在会话详情里定位根因。
      const failText = feishuFailureText(error);
      const cardUpdated = await cardListener?.fail(failText);
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'FAILED');
      const replyText = cardListener == null || cardUpdated === false ? failText : null;
      return { text: replyText, phase: 'FAILED' };
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
      await this.reply(context, '当前任务正在执行中，请稍后再发消息。', sessionId);
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
      await this.reply(context, '当前任务正在执行中，消息排队失败，请稍后重试。', sessionId);
      return;
    }
    try {
      const cardMessageId = await this.options.createQueueCard?.(context, queueId, sessionId) ?? null;
      if (cardMessageId != null) {
        await queueService.setCardMessageId(queueId, cardMessageId);
      } else {
        // 卡片发送失败：降级文本提示。
        await this.reply(context, '当前任务执行中，你的消息已排队等待处理。', sessionId);
      }
    } catch (error) {
      console.error(`飞书排队卡片发送失败, sessionId=${sessionId}, queueId=${queueId}`, error);
      // 卡片失败不影响入队成功，用户至少有文本提示。
      await this.reply(context, '当前任务执行中，你的消息已排队等待处理。', sessionId);
    }
  }

  // ─── 内部：消息构建（不变） ───────────────────────────────────────

  private async buildMessage(context: FeishuInboundContext, workspace: string | null): Promise<string | FeishuContentPart[]> {
    const isGroup = context.chatType === 'group';
    const senderLabel = context.senderLabel?.trim() || '未知用户';
    const sections: string[] = [];
    const groupContext = context.groupContext?.trim();
    if (isGroup && groupContext != null && groupContext !== '') sections.push(`【群内最近消息】\n${groupContext}`);
    const quoted = context.quotedContext?.trim();
    if (quoted != null && quoted !== '') sections.push(`【引用的消息】\n${quoted}`);
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
    // 图片已 data URI 直传模型，落盘路径仅作提示，供 Agent 后续用工具二次读取（同微信）。
    if (media.imagePaths.length > 0) {
      const hint = `图片已保存到会话工作区：${media.imagePaths.join('、')}`;
      body = body.trim() === '' ? hint : `${body}\n${hint}`;
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

  /** p2p chat 级互斥：同一用户的指令判定与归属确定串行（key 与 p2pChatIdOf 的 union 优先策略一致）。 */
  private async withP2pChatLock<T>(context: FeishuInboundContext, fn: () => Promise<T>): Promise<T> {
    const key = `${context.accountId}:${context.senderUnionId ?? context.senderId ?? ''}`;
    const previous = this.p2pChatMutex.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.p2pChatMutex.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.p2pChatMutex.get(key) === queued) this.p2pChatMutex.delete(key);
    }
  }

  /** 统一文本回复：容错发送（失败仅记日志，不影响执行终态）；p2p 出站成功消息记录归属映射。 */
  private async reply(context: FeishuInboundContext, text: string, sessionId?: number): Promise<void> {
    let messageId: string | null = null;
    try {
      messageId = (await this.options.onReply?.(context, text, sessionId)) ?? null;
    } catch (error) {
      console.error(`飞书回复发送失败, sessionId=${sessionId ?? '-'}`, error);
      return;
    }
    if (messageId != null && sessionId != null && context.chatType === 'p2p') {
      await this.options.p2pSessionControl?.recordMessageMapping(context.accountId, messageId, sessionId, 'OUT');
    }
  }

  private removeCancelFlag(sessionId: number, cancelFlag: CancelFlag): void {
    if (this.cancelFlags.get(sessionId) === cancelFlag) {
      this.cancelFlags.delete(sessionId);
      this.options.releaseCancelFlag?.(sessionId);
    }
  }
}

/** 失败终态文案：优先透传 Error.message（与客户端对话页一致），无信息时回退固定安抚文案。 */
function feishuFailureText(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message !== '') return message;
  }
  return '抱歉，处理您的消息时出现了错误，请稍后再试。';
}
