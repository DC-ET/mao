import { randomUUID } from 'node:crypto';
import { FeishuCardProgressListener, countCompletedAgentRounds, type FeishuCardProgress } from '../feishu/card-progress-listener.js';
import { CompositeAgentEventListener } from '../harness/core/composite-agent-event-listener.js';
import { NoopAgentEventListener } from '../harness/core/agent-event-listener.js';
import { userMessagePayloadOf } from '../session/ws/streaming-ws-handler.js';
import { wsEvent } from '../session/ws/ws-event.js';
import type { StreamingWsRegistry } from '../session/ws/streaming-ws-registry.js';
import { isInboundFileMessage, isNewSessionCommand } from './event-normalizer.js';
import { parseChannelCommand, renderChannelSessionList, type ChannelCommand } from '../common/channel-command.js';
import type { ChannelSessionBrief } from '../session/session.repository.js';
import { toWorkspaceRelative } from '../common/workspace-path.js';
import { mapWithConcurrency } from '../common/concurrency.js';
import { isActivePhase } from '../session/util/session-group-key.js';
import { INBOUND_IMAGE_COMPRESS_CONCURRENCY, PromptImageResizer } from '../harness/tool/prompt-image-resizer.js';
import type {
  CancelFlag, DingtalkHarnessService, DingtalkInboundContext, DingtalkInboundHandler,
  DingtalkInboundQueueRow, DingtalkQueuePayload, DingtalkQueueStoredContext, DingtalkReply, DingtalkTaskQueuePort,
} from './types.js';

export interface DingtalkSessionRef {
  id: number;
  workspace?: string | null;
  executionUserId?: number | null;
}

export interface DingtalkSessionAdapter {
  getOrCreateSession(accountId: string, context: DingtalkInboundContext): Promise<DingtalkSessionRef>;
  saveUserMessage(sessionId: number, content: unknown, metadata?: string | null): Promise<number | void>;
  replaceMessageContent?(messageId: number, content: unknown): Promise<void>;
  getLatestAssistantReply(sessionId: number): Promise<string>;
  getMessages?(sessionId: number): Promise<Array<{ role?: string | null }>>;
  updatePhase?(sessionId: number, phase: string): Promise<void>;
  cleanupIncompleteTail?(sessionId: number): Promise<number>;
  getPhase?(sessionId: number): Promise<string | null>;
  /** 最近一次执行的运行身份（技术方案 2026-11-04 §5.2）：重试续跑同一次执行时透传。 */
  getLastRuntimeUserId?(sessionId: number): Promise<number | null>;
}

export interface DingtalkMediaDownload {
  images: string[];
  imagePaths: string[];
  filePaths: string[];
  errors: string[];
}

export interface DingtalkP2pSessionControl {
  findActiveSession(accountId: string, context: DingtalkInboundContext): Promise<{ id: number } | null>;
  createSession(accountId: string, context: DingtalkInboundContext): Promise<{ id: number }>;
  /**
   * `/tasks <n>` 切换私聊指针：归属校验（目标会话存在且属于触发者）+ 指针 upsert。
   * null=指针行不存在 / 目标即当前 / 归属拒绝（调用方回退列表）。
   */
  switchSession?(accountId: string, context: DingtalkInboundContext, targetSessionId: number): Promise<{ id: number } | null>;
  finalizeNewSessionTitle?(sessionId: number, title: string): Promise<boolean>;
}

const NEW_SESSION_CONFIRM_TEXT = '已开启新会话，后续消息将在新的上下文中处理。';
const NEW_SESSION_FAILED_TEXT = '开启新会话失败，请稍后再试。';
const NEW_SESSION_TITLE_MAX_CHARS = 20;

// 渠道控制命令文案（技术方案 2026-11-22 §4.6 文案表；中英混合禁用、emoji 禁用）。
const CHANNEL_COMMAND_FAILED_TEXT = '命令处理失败，请稍后再试。';
const CHANNEL_COMMAND_UNSUPPORTED_TEXT = '此命令暂不支持。';
const STOP_CONFIRM_TEXT = '已停止当前任务。';
const STOP_IDLE_TEXT = '当前没有进行中的任务。';
const GROUP_NO_SESSION_TEXT = '本群还没有会话。';
const TASKS_EMPTY_TEXT = '该渠道还没有任务记录。';
const SWITCH_TASKS_CONFIRM_TEXT = '已切换到「{标题}」，后续消息将以该会话上下文为准。';
const ALREADY_CURRENT_TEXT = '已在当前会话。';
const CHANNEL_HELP_TEXT = [
  '可用命令：',
  '/new 开启新会话',
  '/stop 停止当前任务',
  '/tasks 查看最近任务',
  '/tasks <序号> 切换到对应任务，如 /tasks 2',
  '/help 显示本帮助',
].join('\n');
const GROUP_HELP_TEXT = [
  '可用命令：',
  '/stop 停止当前任务（群内任意成员可停止群任务）',
  '/help 显示本帮助',
].join('\n');
const NOOP_CANCEL_FLAG: CancelFlag = { get: () => false, set: () => undefined };

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; imageUrl: { url: string } };

interface BuiltMessage { persisted: unknown; forModel: unknown; }

interface P2pOutcome {
  intercepted: boolean;
  confirm?: string;
  sessionId?: number;
  session?: DingtalkSessionRef;
}

export class AgentDingtalkInboundHandler implements DingtalkInboundHandler {
  private readonly mutex = new Map<number, Promise<void>>();
  private readonly busy = new Set<number>();
  private readonly cancelFlags = new Map<number, CancelFlag>();
  private readonly interrupted = new Set<number>();
  private readonly p2pChatMutex = new Map<string, Promise<void>>();
  private readonly fileIngestGates = new Map<number, Promise<unknown>>();
  private readonly pendingAttachments = new Map<number, string[]>();
  /** 私聊 `---` 换走指针后，旧会话队列不再执行，避免和该私聊的新会话并行回复。 */
  private readonly abandoned = new Set<number>();

  constructor(private readonly options: {
    sessionService: DingtalkSessionAdapter;
    harnessService: DingtalkHarnessService;
    registry?: StreamingWsRegistry;
    resolveStreamUserId?: (sessionId: number) => Promise<number | null>;
    createCancelFlag?: (sessionId: number) => CancelFlag;
    releaseCancelFlag?: (sessionId: number) => void;
    onInterruptRunning?: (sessionId: number) => void;
    resolveIdleRunning?: (sessionId: number) => Promise<void>;
    /** 私聊 `---` 在置取消标志后收尾：有循环则只靠标志，否则补写 CANCELLED。 */
    settleCancel?: (sessionId: number) => Promise<void>;
    downloadMedia?: (context: DingtalkInboundContext, workspace: string | null) => Promise<DingtalkMediaDownload | null>;
    listenerFactory?: (sessionId: number, context: DingtalkInboundContext, executionId: string) => Promise<Parameters<DingtalkHarnessService['execute']>[2]>;
    onExecutionFinished?: (sessionId: number, context: DingtalkInboundContext, executionId: string, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', failureReason?: string) => Promise<void>;
    /** 回复发出之后再清进度卡映射，便于发送失败时把原因写回卡片。 */
    afterDelivery?: (sessionId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>;
    /** 失败重试没有入站上下文，按进度卡映射还原发送目标。 */
    resolveReplyContext?: (sessionId: number) => Promise<DingtalkInboundContext | null>;
    createProgressCard?: (context: DingtalkInboundContext, sessionId: number) => Promise<FeishuCardProgress | null>;
    queueService?: DingtalkTaskQueuePort;
    /**
     * 跨通道忙判定：WS/桌面端（含 autoConsume 消费 message_queue）正在执行本会话时，
     * IM 收尾的排空与直接执行都必须让行——两套执行簿记互不可见，不让行会双跑。
     */
    isSessionExecuting?: (sessionId: number) => boolean;
    /**
     * 入站队列排空且会话空闲时，接力消费平台排队消息（message_queue：定时任务/Webhook/插队）。
     * 覆盖「定时任务在会话忙时入队 → 该会话后续只有钉钉执行」导致的永久排队。
     */
    onQueuesDrained?: (sessionId: number) => void;
    createQueueCard?: (context: DingtalkInboundContext, queueId: number, sessionId: number, rankNo?: number) => Promise<string | null>;
    resolveBotId?: (accountId: string) => number;
    /**
     * 渠道控制命令 `/stop`：终止指定会话的进行中执行（与互动卡「取消」同一服务闭包，装配层同喂两处）。
     * 返回 true=已置取消（含崩溃恢复补写终态），false=空闲。未配置时命令回「暂不支持」。
     */
    stopRunning?: (sessionId: number) => Promise<boolean>;
    /** 渠道控制命令 `/tasks`：该用户本渠道最近会话简报（群聊绑定会话已由装配层排除）。 */
    listChannelSessions?: (userId: number, limit: number) => Promise<ChannelSessionBrief[]>;
    p2pSessionControl?: DingtalkP2pSessionControl;
    onReply?: (context: DingtalkInboundContext, text: string, sessionId?: number) => Promise<void>;
    noteReplyFailure?: (sessionId: number, reason: string) => Promise<void>;
  }) {}

  interrupt(sessionId: number): boolean {
    const flag = this.cancelFlags.get(sessionId);
    if (flag != null) {
      flag.set(true);
      this.interrupted.add(sessionId);
    }
    this.options.onInterruptRunning?.(sessionId);
    return flag != null;
  }

  cancel(sessionId: number): boolean {
    const flag = this.cancelFlags.get(sessionId);
    if (flag != null) flag.set(true);
    this.options.onInterruptRunning?.(sessionId);
    return flag != null;
  }

  /** IM 侧是否正在执行（供 WS autoConsume 的跨通道忙检查；同步、无副作用）。 */
  hasRunningSession(sessionId: number): boolean {
    return this.busy.has(sessionId);
  }

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
      // 与 busy.add 同一同步段复检 WS 占位（同 executeWithSession 的说明）。
      if (this.options.isSessionExecuting?.(sessionId) === true) return;
      this.busy.add(sessionId);
      const progress = await createProgress().catch(() => null);
      if (progress == null) {
        this.busy.delete(sessionId);
        outcome = { ok: false, reason: 'NO_PROGRESS' };
        return;
      }
      outcome = { ok: true };
      void this.runRetry(sessionId, progress).then(async (phase) => {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
        if (phase !== 'FAILED') await this.drainNextIfPending(sessionId);
      }).catch((error) => {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
        console.error(`钉钉重试后台执行未捕获异常, sessionId=${sessionId}`, error);
      });
    });
    return outcome;
  }

  interruptAndDrain(sessionId: number): void {
    const hit = this.interrupt(sessionId);
    if (hit) {
      void this.drainNextIfPending(sessionId).catch((error) => console.error(`钉钉插队后排空异常, sessionId=${sessionId}`, error));
      return;
    }
    const resolveIdle = this.options.resolveIdleRunning;
    if (resolveIdle == null) {
      void this.drainNextIfPending(sessionId).catch((error) => console.error(`钉钉插队后排空异常, sessionId=${sessionId}`, error));
      return;
    }
    void resolveIdle(sessionId).then(() => this.drainNextIfPending(sessionId)).catch((error) => {
      console.error(`钉钉插队后排空异常, sessionId=${sessionId}`, error);
    });
  }

  async drainNextIfPending(sessionId: number): Promise<void> {
    await this.flushAttachmentsAndDrain(sessionId, null).catch((error) => {
      console.error(`钉钉队列消费异常, sessionId=${sessionId}`, error);
    });
  }

  async onMessage(context: DingtalkInboundContext): Promise<DingtalkReply | null> {
    if (context.chatType === 'p2p' && this.options.p2pSessionControl != null) return this.onP2pMessage(context);
    // 群聊渠道控制命令（/stop /help，技术方案 2026-11-22）：text 已由 cleanText 剥 @，全等命中即拦截。
    // 只认 STOP / HELP——群 /new、/tasks 不做（§2.2）。未 @ 的群消息在 processor 处已被丢弃，不会到这里。
    if (context.chatType !== 'p2p') {
      const groupCommand = parseChannelCommand(context.text);
      if (groupCommand.kind === 'STOP') return this.handleGroupStopCommand(context);
      if (groupCommand.kind === 'HELP') {
        await this.options.onReply?.(context, GROUP_HELP_TEXT);
        return null;
      }
    }
    const session = await this.options.sessionService.getOrCreateSession(context.accountId, context);
    return this.executeWithSession(session, context);
  }

  private async onP2pMessage(context: DingtalkInboundContext): Promise<DingtalkReply | null> {
    const outcome = await this.withP2pChatLock(context, async (): Promise<P2pOutcome> => {
      const command = parseChannelCommand(context.text);
      // `/new` 与 `---` 同走新建分支（完整 abandon 语义）。
      if (command.kind === 'NEW' || isNewSessionCommand(context.text)) return this.openNewSession(context);
      // 渠道控制命令（/stop /tasks /tasks <n> /help）：命中即拦截，不进会话消息流、不触发 Agent。
      if (command.kind === 'STOP' || command.kind === 'TASKS' || command.kind === 'TASKS_SELECT' || command.kind === 'HELP') {
        return this.handleP2pCommand(context, command);
      }
      const session = await this.options.sessionService.getOrCreateSession(context.accountId, context);
      await this.renameIfNeeded(session.id, context);
      if (isInboundFileMessage(context)) {
        await this.ingestFileWithoutExecute(session, context);
        return { intercepted: true };
      }
      return { intercepted: false, session };
    });
    if (outcome.confirm != null) await this.reply(context, outcome.confirm, outcome.sessionId);
    if (outcome.intercepted || outcome.session == null) return null;
    return this.executeWithSession(outcome.session, context);
  }

  /**
   * 私聊渠道控制命令（技术方案 2026-11-22 §4.4）：结构与飞书私聊同构。
   * 命令埠未配置（测试直调 / 旧装配）时回「暂不支持」，不让命令文本落进 Agent。
   */
  private async handleP2pCommand(context: DingtalkInboundContext, command: ChannelCommand): Promise<P2pOutcome> {
    const control = this.options.p2pSessionControl!;
    try {
      if (command.kind === 'STOP') {
        const stopRunning = this.options.stopRunning;
        if (stopRunning == null) return { intercepted: true, confirm: CHANNEL_COMMAND_UNSUPPORTED_TEXT };
        const active = await control.findActiveSession(context.accountId, context);
        if (active == null) return { intercepted: true, confirm: STOP_IDLE_TEXT };
        const ok = await stopRunning(active.id);
        return { intercepted: true, confirm: ok ? STOP_CONFIRM_TEXT : STOP_IDLE_TEXT };
      }
      if (command.kind === 'TASKS' || command.kind === 'TASKS_SELECT') {
        const listChannelSessions = this.options.listChannelSessions;
        if (listChannelSessions == null) return { intercepted: true, confirm: CHANNEL_COMMAND_UNSUPPORTED_TEXT };
        const briefs = await listChannelSessions(context.maoUserId ?? 0, 5);
        const listText = (): string => (briefs.length === 0 ? TASKS_EMPTY_TEXT : renderChannelSessionList(briefs, isActivePhase));
        if (command.kind === 'TASKS' || command.index > briefs.length) {
          // 裸 /tasks、空列表、越界序号：一律回列表（越界回退是 D8 定案）。
          return { intercepted: true, confirm: listText() };
        }
        const target = briefs[command.index - 1]!;
        const active = await control.findActiveSession(context.accountId, context);
        if (active != null && active.id === target.id) {
          return { intercepted: true, confirm: ALREADY_CURRENT_TEXT };
        }
        const switched = await control.switchSession?.(context.accountId, context, target.id);
        if (switched == null) {
          // 指针行不存在 / 目标即当前前置已挡 / 归属拒绝（列表过期间隙）：回退列表。不动旧会话。
          return { intercepted: true, confirm: listText() };
        }
        // D5：切换成功后按 `---` 既有 abandon 序列收尾旧会话（取消执行、补写终态、放弃排队消息）；
        // 归属拒绝/指针缺失时不收尾——旧任务保持原状。
        if (active != null && active.id !== switched.id) {
          await this.abandonSession(active.id);
        }
        const title = (target.title ?? '').trim() === '' ? '未命名会话' : target.title!;
        return { intercepted: true, confirm: SWITCH_TASKS_CONFIRM_TEXT.replace('{标题}', title), sessionId: switched.id };
      }
      return { intercepted: true, confirm: CHANNEL_HELP_TEXT };
    } catch (error) {
      console.error(`钉钉私聊渠道命令处理失败, accountId=${context.accountId}, messageId=${context.messageId}`, error);
      return { intercepted: true, confirm: CHANNEL_COMMAND_FAILED_TEXT };
    }
  }

  /**
   * 群命令 `/stop`（技术方案 2026-11-22 D7）：群会话是共享决策面，不校验触发成员。
   * 目标为群级会话行（conversation 表 group 行与 p2p 行同构，findActive 不区分 chatType，只读）。
   */
  private async handleGroupStopCommand(context: DingtalkInboundContext): Promise<DingtalkReply | null> {
    const stopRunning = this.options.stopRunning;
    const findActiveSession = this.options.p2pSessionControl?.findActiveSession;
    if (stopRunning == null || findActiveSession == null) {
      await this.options.onReply?.(context, CHANNEL_COMMAND_UNSUPPORTED_TEXT);
      return null;
    }
    try {
      const active = await findActiveSession(context.accountId, context);
      if (active == null) {
        await this.options.onReply?.(context, GROUP_NO_SESSION_TEXT);
        return null;
      }
      const ok = await stopRunning(active.id);
      await this.options.onReply?.(context, ok ? STOP_CONFIRM_TEXT : STOP_IDLE_TEXT);
    } catch (error) {
      console.error(`钉钉群 /stop 处理失败, accountId=${context.accountId}, conversationId=${context.conversationId}`, error);
      await this.options.onReply?.(context, CHANNEL_COMMAND_FAILED_TEXT);
    }
    return null;
  }

  private async openNewSession(context: DingtalkInboundContext): Promise<P2pOutcome> {
    const control = this.options.p2pSessionControl!;
    const active = await control.findActiveSession(context.accountId, context);
    if (active != null) {
      await this.abandonSession(active.id);
    }
    try {
      const created = await control.createSession(context.accountId, context);
      return { intercepted: true, confirm: NEW_SESSION_CONFIRM_TEXT, sessionId: created.id };
    } catch (error) {
      console.error(`钉钉私聊新建会话失败, accountId=${context.accountId}, messageId=${context.messageId}`, error);
      return { intercepted: true, confirm: NEW_SESSION_FAILED_TEXT };
    }
  }

  /**
   * `---` 与 `/tasks <n>` 切换共用的旧会话收尾序列（技术方案 2026-11-22 R3，逐字复用 `---` 既有语义）：
   * 标记放弃（旧会话队列不再执行）→ 置取消 → 补写 CANCELLED → 丢弃排队消息。
   */
  private async abandonSession(sessionId: number): Promise<void> {
    this.abandoned.add(sessionId);
    this.cancel(sessionId);
    await this.options.settleCancel?.(sessionId);
    await this.dropQueued(sessionId);
  }

  private async renameIfNeeded(sessionId: number, context: DingtalkInboundContext): Promise<void> {
    const text = context.text.trim();
    if (text === '' || this.options.p2pSessionControl?.finalizeNewSessionTitle == null) return;
    const title = text.length > NEW_SESSION_TITLE_MAX_CHARS ? text.slice(0, NEW_SESSION_TITLE_MAX_CHARS) : text;
    await this.options.p2pSessionControl.finalizeNewSessionTitle(sessionId, title).catch(() => false);
  }

  private async executeWithSession(session: DingtalkSessionRef, context: DingtalkInboundContext): Promise<DingtalkReply | null> {
    if (isInboundFileMessage(context)) {
      await this.ingestFileWithoutExecute(session, context);
      return null;
    }
    await this.awaitFileIngest(session.id);
    const built = await this.buildMessage(context, session.workspace ?? null);
    if (await this.isBusyOrRecovering(session.id)) {
      await this.enqueueMessage(session.id, context, built, session);
      return null;
    }
    let executed = false;
    let phase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED';
    await this.withLock(session.id, async () => {
      if (await this.isBusyOrRecovering(session.id)) {
        await this.enqueueMessage(session.id, context, built, session);
        return;
      }
      // 与 busy.add 同一同步段复检 WS 占位：两套簿记的「检查-占位」必须是原子的，
      // 否则 WS 恰在 isBusyOrRecovering 的 await 期间占位时会双跑。
      if (this.options.isSessionExecuting?.(session.id) === true) {
        await this.enqueueMessage(session.id, context, built, session);
        return;
      }
      this.busy.add(session.id);
      executed = true;
      try {
        phase = await this.executeDirect(session.id, context, built, session);
      } finally {
        this.busy.delete(session.id);
        this.interrupted.delete(session.id);
      }
    });
    if (executed) {
      void this.flushAttachmentsAndDrain(session.id, session.executionUserId ?? context.maoUserId ?? null, phase !== 'FAILED')
        .catch((error) => console.error(`钉钉队列消费接力异常, sessionId=${session.id}`, error));
    }
    return null;
  }

  private async executeDirect(
    sessionId: number, context: DingtalkInboundContext, built: BuiltMessage, session: DingtalkSessionRef,
  ): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED'> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    try {
      const result = await this.runExecution(sessionId, context, built, session.executionUserId ?? context.maoUserId ?? null, cancelFlag);
      if (result.text) await this.reply(context, result.text, sessionId);
      await this.options.afterDelivery?.(sessionId, result.phase);
      return result.phase;
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
    }
  }

  private async runExecution(
    sessionId: number, context: DingtalkInboundContext, built: BuiltMessage,
    executionUserId: number | null, cancelFlag: CancelFlag, queueRow?: DingtalkInboundQueueRow | null,
  ): Promise<{ text: string | null; phase: 'COMPLETED' | 'CANCELLED' | 'FAILED' }> {
    let executionId = '';
    let cardListener: FeishuCardProgressListener | null = null;
    let savedId: number | null = null;
    const swap = built.persisted !== built.forModel;
    try {
      try {
        const progress = await this.options.createProgressCard?.(context, sessionId) ?? null;
        if (progress != null) cardListener = new FeishuCardProgressListener(progress);
      } catch (error) {
        console.warn(`钉钉进度卡片创建失败，继续执行: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.options.sessionService.updatePhase?.(sessionId, 'RUNNING');
      const metadata = queueRow != null ? JSON.stringify({ dingtalkQueueId: queueRow.id }) : null;
      const saved = await this.options.sessionService.saveUserMessage(sessionId, built.persisted, metadata);
      savedId = typeof saved === 'number' ? saved : null;
      this.echoUserMessageSaved(sessionId, executionUserId, built.persisted);
      if (swap && savedId != null) await this.options.sessionService.replaceMessageContent?.(savedId, built.forModel);
      const eventId = await this.options.harnessService.prepareMessage(sessionId, built.forModel);
      executionId = eventId || '';
      await this.broadcastRunning(sessionId, executionId, executionUserId);
      const listener = await this.options.listenerFactory?.(sessionId, context, executionId);
      if (listener == null) throw new Error('Dingtalk listenerFactory is required to execute a harness session');
      await this.options.harnessService.execute(
        sessionId, eventId || null,
        cardListener == null ? listener : CompositeAgentEventListener.of(listener, cardListener),
        cancelFlag, executionUserId,
      );
      if (cancelFlag.get()) {
        const wasInterrupted = this.interrupted.has(sessionId);
        await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
        const cancelled = await cardListener?.cancel(wasInterrupted);
        await this.options.onExecutionFinished?.(sessionId, context, executionId, 'CANCELLED');
        const text = cardListener == null || cancelled === false
          ? (wasInterrupted ? '任务已被下一条消息中断。' : '任务已取消。')
          : null;
        return { text, phase: 'CANCELLED' };
      }
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      // 卡片终态更新成功就靠卡片呈现结果，不再另发一条消息；更新失败（网络抖动/模板问题）
      // 才回落文本，避免用户两边都收不到。与飞书同口径。
      const completed = await cardListener?.complete(text);
      return { text: cardListener == null || completed === false ? text : null, phase: 'COMPLETED' };
    } catch (error) {
      console.error(`钉钉 Agent 执行失败, sessionId=${sessionId}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      const failText = error instanceof Error ? error.message : 'Agent 执行异常';
      const failed = await cardListener?.fail(failText);
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'FAILED', failText);
      return { text: cardListener == null || failed === false ? failText : null, phase: 'FAILED' };
    } finally {
      if (swap && savedId != null) {
        await this.options.sessionService.replaceMessageContent?.(savedId, built.persisted).catch((error) => {
          console.warn(`钉钉群上下文还原失败, messageId=${savedId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  private async runRetry(sessionId: number, progress: FeishuCardProgress): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED'> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    let cardListener: FeishuCardProgressListener | null = null;
    const stub = { accountId: '0', chatType: 'p2p', conversationId: '', messageId: '', senderUserid: null, senderUnionId: null, senderName: '', msgtype: 'text', text: '', downloadCodes: [], fileName: null, quotedText: null, isInAtList: true } as DingtalkInboundContext;
    try {
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      await this.options.sessionService.updatePhase?.(sessionId, 'RUNNING');
      let roundOffset = 0;
      try { roundOffset = countCompletedAgentRounds(await this.options.sessionService.getMessages?.(sessionId)); } catch { roundOffset = 0; }
      cardListener = new FeishuCardProgressListener(progress, roundOffset);
      await progress.update('RUNNING', roundOffset, '正在重试，请稍候…', []).catch(() => undefined);
      const executionId = randomUUID();
      await this.broadcastRunning(sessionId, executionId, null);
      const listener = await this.options.listenerFactory?.(sessionId, stub, executionId) ?? new NoopAgentEventListener();
      // 重试续跑同一次执行（技术方案 2026-11-04 §5.2）：按持久化的运行身份恢复；读取失败回落 owner。
      let retryRuntimeUserId: number | null = null;
      try {
        retryRuntimeUserId = (await this.options.sessionService.getLastRuntimeUserId?.(sessionId)) ?? null;
      } catch (e) {
        // 读取失败回落 owner（与崩溃恢复同源语义），但留痕：否则「身份漂移」在故障时静默复现。
        console.warn(`钉钉重试读取运行身份失败，回落 owner, sessionId=${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.options.harnessService.execute(
        sessionId, null, CompositeAgentEventListener.of(listener, cardListener), cancelFlag, retryRuntimeUserId,
      );
      if (cancelFlag.get()) {
        await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
        const cancelled = await cardListener.cancel(this.interrupted.has(sessionId));
        await this.options.onExecutionFinished?.(sessionId, stub, executionId, 'CANCELLED');
        await this.options.afterDelivery?.(sessionId, 'CANCELLED');
        if (!cancelled) await this.reply(await this.replyContext(sessionId, stub), '任务已取消。', sessionId);
        return 'CANCELLED';
      }
      await this.options.onExecutionFinished?.(sessionId, stub, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      const completed = await cardListener.complete(text);
      // 卡片终态更新成功就靠卡片呈现结果，不再另发一条消息；失败才回落文本（与 runExecution 同口径）。
      if (!completed && text !== '') {
        await this.reply(await this.replyContext(sessionId, stub), text, sessionId);
      }
      await this.options.afterDelivery?.(sessionId, 'COMPLETED');
      return 'COMPLETED';
    } catch (error) {
      const failText = error instanceof Error ? error.message : 'Agent 执行异常';
      const failed = await cardListener?.fail(failText);
      await this.options.onExecutionFinished?.(sessionId, stub, '', 'FAILED', failText);
      if (failed === false && failText !== '') {
        await this.reply(await this.replyContext(sessionId, stub), failText, sessionId);
      }
      await this.options.afterDelivery?.(sessionId, 'FAILED');
      return 'FAILED';
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
    }
  }

  private async enqueueMessage(sessionId: number, context: DingtalkInboundContext, built: BuiltMessage, session: DingtalkSessionRef): Promise<void> {
    const queueService = this.options.queueService;
    if (queueService == null) {
      await this.reply(context, '当前任务正在执行中，请稍后再发消息。', sessionId);
      return;
    }
    const botId = this.options.resolveBotId?.(context.accountId) ?? Number(context.accountId);
    const payload = JSON.stringify(buildQueuePayload(botId, context, built));
    let queued: { id: number; rankNo: number | null };
    try {
      queued = await queueService.enqueue({
        sessionId, botId, messageId: context.messageId, senderUserid: context.senderUserid ?? '',
        maoUserId: session.executionUserId ?? context.maoUserId ?? null, payload,
      });
    } catch (error) {
      console.error(`钉钉消息入队失败, sessionId=${sessionId}`, error);
      await this.reply(context, '当前任务正在执行中，消息排队失败，请稍后重试。', sessionId);
      return;
    }
    const queueId = queued.id;
    const outTrackId = await this.options.createQueueCard?.(context, queueId, sessionId, queued.rankNo ?? undefined).catch(() => null) ?? null;
    if (outTrackId != null) await queueService.setOutTrackId(queueId, outTrackId);
    else await this.reply(context, '当前任务执行中，你的消息已排队等待处理。', sessionId);
  }

  private async drainNext(sessionId: number, executionUserId: number | null): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED' | null> {
    const queueService = this.options.queueService;
    // 本次排空链确认「队列为空且会话空闲」时置位：链尾接力消费平台排队消息（message_queue）。
    let drainedIdle = false;
    const phase = await this.withLock(sessionId, async () => {
      if (await this.isBusyOrRecovering(sessionId)) return null;
      if (this.hasPendingAttachments(sessionId)) await this.persistPendingAttachments(sessionId, executionUserId);
      if (queueService == null) {
        drainedIdle = true;
        return null;
      }
      // 与 busy.add 同一同步段复检 WS 占位（同 executeWithSession 的说明），
      // 占位提前到 claimNext 之前：WS 检查-占位若恰好插在 DB 往返期间，会看到本会话已忙而让行。
      if (this.options.isSessionExecuting?.(sessionId) === true) return null;
      this.busy.add(sessionId);
      try {
        const item = await queueService.claimNext(sessionId);
        if (item == null) {
          drainedIdle = true;
          return null;
        }
        return await this.executeQueued(sessionId, item);
      } finally {
        this.busy.delete(sessionId);
        this.interrupted.delete(sessionId);
      }
    });
    if (drainedIdle) {
      // 钉钉队列排空且会话空闲：接力消费平台排队消息（定时任务/Webhook/插队），
      // 否则「会话忙时入队、之后只有钉钉执行」的消息会永远停在 QUEUED。
      this.relayPlatformQueues(sessionId);
    }
    return phase;
  }

  /** 钉钉队列排空且会话空闲：接力消费平台排队消息（message_queue）。失败不外抛。 */
  private relayPlatformQueues(sessionId: number): void {
    try {
      this.options.onQueuesDrained?.(sessionId);
    } catch (e) {
      console.warn(`钉钉队列排空后接力消费平台队列失败, sessionId=${sessionId}`, e);
    }
  }

  private async flushAttachmentsAndDrain(sessionId: number, executionUserId: number | null, drain = true): Promise<void> {
    if (this.abandoned.has(sessionId)) {
      await this.withLock(sessionId, async () => { await this.dropQueued(sessionId); });
      this.abandoned.delete(sessionId);
      return;
    }
    const ingest = this.fileIngestGates.get(sessionId);
    if (ingest != null) await ingest;
    if (!drain) {
      if (!this.hasPendingAttachments(sessionId)) return;
      await this.withLock(sessionId, async () => {
        if (await this.isBusyOrRecovering(sessionId)) return;
        if (this.hasPendingAttachments(sessionId)) await this.persistPendingAttachments(sessionId, executionUserId);
      });
      return;
    }
    const phase = await this.drainNext(sessionId, executionUserId);
    if (phase != null && phase !== 'FAILED') {
      void this.drainNext(sessionId, executionUserId).then((next) => {
        if (next != null && next !== 'FAILED') void this.flushAttachmentsAndDrain(sessionId, executionUserId);
      }).catch((error) => console.error(`钉钉队列消费接力异常, sessionId=${sessionId}`, error));
    }
  }

  private async executeQueued(sessionId: number, row: DingtalkInboundQueueRow): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED'> {
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    try {
      const payload = JSON.parse(row.payload) as DingtalkQueuePayload;
      const context = contextFromQueue(payload, row);
      const result = await this.runExecution(sessionId, context, { persisted: payload.persisted, forModel: payload.forModel }, row.maoUserId, cancelFlag, row);
      if (result.text) await this.reply(context, result.text, sessionId);
      await this.options.afterDelivery?.(sessionId, result.phase);
      return result.phase;
    } catch (error) {
      console.error(`钉钉队列消息执行失败, queueId=${row.id}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      return 'FAILED';
    } finally {
      this.removeCancelFlag(sessionId, cancelFlag);
      await this.options.queueService?.complete(row.id).catch((error) => console.error(`钉钉队列行清理失败, queueId=${row.id}`, error));
    }
  }

  private async isBusyOrRecovering(sessionId: number): Promise<boolean> {
    if (this.busy.has(sessionId)) return true;
    // WS 侧执行（含 autoConsume 消费 message_queue）占用会话时同样视为忙：
    // 两套执行簿记互不可见，必须靠本检查让 IM 通道让行。
    if (this.options.isSessionExecuting?.(sessionId) === true) return true;
    const phase = this.options.sessionService.getPhase == null ? null : await this.options.sessionService.getPhase(sessionId).catch(() => null);
    // 口径与 isActivePhase 统一（含 WAITING_APPROVAL / CANCELLING），与 WS 侧忙判定一致。
    return isActivePhase(phase);
  }

  private async buildMessage(context: DingtalkInboundContext, workspace: string | null): Promise<BuiltMessage> {
    const sections: string[] = [];
    const quoted = context.quotedText?.trim();
    if (quoted) sections.push(`【引用的消息】\n${quoted}`);
    if (context.chatType === 'group') sections.push(`【用户消息】\n${context.senderLabel?.trim() || context.senderName}：${context.text}`);
    else sections.push(context.text);
    const persistedText = sections.join('\n\n');
    const media = await this.options.downloadMedia?.(context, workspace) ?? null;
    const persisted = media == null ? persistedText : await composeContent(persistedText, media, workspace);
    const group = context.groupContext?.trim();
    if (group == null || group === '') return { persisted, forModel: persisted };
    const forModel = prependGroup(persisted, group);
    return { persisted, forModel };
  }

  private ingestFileWithoutExecute(session: DingtalkSessionRef, context: DingtalkInboundContext): Promise<void> {
    return this.runFileIngest(session.id, async () => {
      const media = await this.options.downloadMedia?.(context, session.workspace ?? null) ?? { images: [], imagePaths: [], filePaths: [], errors: [] };
      const content = await fileAttachmentContent(context, media, session.workspace ?? null);
      if (await this.isBusyOrRecovering(session.id)) {
        this.stash(session.id, content);
        return;
      }
      await this.withLock(session.id, async () => {
        if (await this.isBusyOrRecovering(session.id)) {
          this.stash(session.id, content);
          return;
        }
        await this.saveAttachment(session.id, content, session.executionUserId ?? context.maoUserId ?? null);
      });
    });
  }

  private stash(sessionId: number, content: string): void {
    if (content.trim() === '') return;
    const existing = this.pendingAttachments.get(sessionId) ?? [];
    existing.push(content.trim());
    this.pendingAttachments.set(sessionId, existing);
  }

  private hasPendingAttachments(sessionId: number): boolean {
    return (this.pendingAttachments.get(sessionId)?.length ?? 0) > 0;
  }

  private async persistPendingAttachments(sessionId: number, executionUserId: number | null): Promise<void> {
    const lines = this.pendingAttachments.get(sessionId);
    if (lines == null || lines.length === 0) return;
    this.pendingAttachments.delete(sessionId);
    await this.saveAttachment(sessionId, lines.join('\n'), executionUserId);
  }

  private async saveAttachment(sessionId: number, content: string, executionUserId: number | null): Promise<void> {
    if (content.trim() === '') return;
    await this.options.sessionService.saveUserMessage(sessionId, content, null);
    this.echoUserMessageSaved(sessionId, executionUserId, content);
  }

  private runFileIngest<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.fileIngestGates.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.fileIngestGates.set(sessionId, queued);
    return previous.then(fn).finally(() => {
      release();
      if (this.fileIngestGates.get(sessionId) === queued) this.fileIngestGates.delete(sessionId);
    });
  }

  private async awaitFileIngest(sessionId: number): Promise<void> {
    const gate = this.fileIngestGates.get(sessionId);
    if (gate != null) await gate;
  }

  private async dropQueued(sessionId: number): Promise<void> {
    const queue = this.options.queueService;
    if (queue == null) return;
    for (;;) {
      const item = await queue.claimNext(sessionId);
      if (item == null) return;
      await queue.complete(item.id).catch((error) => console.error(`钉钉丢弃旧会话队列失败, queueId=${item.id}`, error));
    }
  }

  private async replyContext(sessionId: number, fallback: DingtalkInboundContext): Promise<DingtalkInboundContext> {
    const resolved = await this.options.resolveReplyContext?.(sessionId).catch(() => null);
    return resolved ?? fallback;
  }

  private async reply(context: DingtalkInboundContext, text: string, sessionId?: number): Promise<void> {
    try {
      await this.options.onReply?.(context, text, sessionId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`钉钉回复发送失败, messageId=${context.messageId}`, error);
      if (sessionId != null) await this.options.noteReplyFailure?.(sessionId, reason).catch(() => undefined);
    }
  }

  private async broadcastRunning(sessionId: number, executionId: string, fallbackUserId: number | null): Promise<void> {
    if (this.options.registry == null || executionId.trim() === '') return;
    let userId = fallbackUserId;
    if (this.options.resolveStreamUserId != null) {
      const resolved = await this.options.resolveStreamUserId(sessionId).catch(() => null);
      if (resolved != null) userId = resolved;
    }
    if (userId == null) return;
    this.options.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RUNNING', executionId }));
    this.options.registry.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
  }

  private echoUserMessageSaved(sessionId: number, executionUserId: number | null, message: unknown): void {
    if (executionUserId == null || this.options.registry == null) return;
    const payload = userMessagePayloadOf(message);
    this.options.registry.send(executionUserId, wsEvent('user_message_saved', sessionId, {
      messageId: null, source: 'dingtalk', tempEventId: '', content: payload.content,
      ...(payload.images.length > 0 ? { images: payload.images } : {}),
    }));
  }

  private removeCancelFlag(sessionId: number, flag: CancelFlag): void {
    if (this.cancelFlags.get(sessionId) === flag) this.cancelFlags.delete(sessionId);
    this.options.releaseCancelFlag?.(sessionId);
  }

  private async withLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.mutex.set(sessionId, queued);
    await previous;
    try { return await fn(); } finally {
      release();
      if (this.mutex.get(sessionId) === queued) this.mutex.delete(sessionId);
    }
  }

  private async withP2pChatLock<T>(context: DingtalkInboundContext, fn: () => Promise<T>): Promise<T> {
    const key = `${context.accountId}:${context.conversationId}`;
    const previous = this.p2pChatMutex.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.p2pChatMutex.set(key, queued);
    await previous;
    try { return await fn(); } finally {
      release();
      if (this.p2pChatMutex.get(key) === queued) this.p2pChatMutex.delete(key);
    }
  }
}

function buildQueuePayload(botId: number, context: DingtalkInboundContext, built: BuiltMessage): DingtalkQueuePayload {
  const stored: DingtalkQueueStoredContext = {
    accountId: context.accountId, chatType: context.chatType, conversationId: context.conversationId,
    senderUserid: context.senderUserid, senderUnionId: context.senderUnionId, senderName: context.senderName,
    maoUserId: context.maoUserId, messageId: context.messageId, senderLabel: context.senderLabel,
    groupContext: context.groupContext, quotedText: context.quotedText, msgtype: context.msgtype,
    text: context.text, fileName: context.fileName,
  };
  return { persisted: built.persisted, forModel: built.forModel, context: stored, botId };
}

/** 队列行 → 入站上下文（含一卡到底的 progressCardOutTrackId 透传）。导出仅为单测（仓库纯函数可测惯例）。 */
export function contextFromQueue(payload: DingtalkQueuePayload, row: DingtalkInboundQueueRow): DingtalkInboundContext {
  const s = payload.context;
  return {
    accountId: s.accountId, chatType: s.chatType, conversationId: s.conversationId, messageId: s.messageId,
    senderUserid: s.senderUserid, senderUnionId: s.senderUnionId, senderName: s.senderName,
    msgtype: s.msgtype, text: s.text, downloadCodes: [], fileName: s.fileName, quotedText: s.quotedText ?? null,
    isInAtList: true, maoUserId: row.maoUserId ?? s.maoUserId, groupContext: s.groupContext, senderLabel: s.senderLabel,
    // 一卡到底：排队卡实例 ID 随上下文进入 createProgressCard，就地升级为进度卡（飞书 progressCardMessageId 同义）
    progressCardOutTrackId: row.outTrackId,
  };
}

async function composeContent(text: string, media: DingtalkMediaDownload, workspace: string | null): Promise<string | ContentPart[]> {
  let body = text;
  if (media.errors.length > 0) {
    const notice = `[以下文件接收失败：${media.errors.join('、')}]`;
    body = body.trim() === '' ? notice : `${body}\n${notice}`;
  }
  if (media.filePaths.length > 0) {
    const refs = media.filePaths.map((path) => `@{${path}}@`).join('\n');
    body = body.trim() === '' ? refs : `${body}\n${refs}`;
  }
  // 落盘路径提示用工作区相对路径：工具与 Shell 均按会话工作区解析，绝对路径冗长且无额外信息。
  if (media.imagePaths.length > 0) {
    const hint = `图片已保存到会话工作区：${media.imagePaths.map((path) => toWorkspaceRelative(workspace, path)).join('、')}`;
    body = body.trim() === '' ? hint : `${body}\n${hint}`;
  }
  if (media.images.length === 0) return body;
  const parts: ContentPart[] = [{ type: 'text', text: body.trim() === '' ? '请查看图片' : body }];
  // 入站图片写入前压一次：落盘原图不变，消息内 data URI 控制在 1.2MB 级（技术方案 2026-10-22 §7.1）。
  // 有界并发（2）压缩，避免串行推迟入库、也避免多张大图同时解码顶爆内存。
  const uris = await mapWithConcurrency(
    media.images,
    INBOUND_IMAGE_COMPRESS_CONCURRENCY,
    (uri) => PromptImageResizer.compressDataUriForStore(uri),
  );
  for (const url of uris) parts.push({ type: 'image_url', imageUrl: { url } });
  return parts;
}

function prependGroup(content: unknown, group: string): unknown {
  const block = `${group}\n\n`;
  if (typeof content === 'string') return `${block}${content}`;
  if (!Array.isArray(content)) return `${block}${String(content)}`;
  const parts = content.map((part) => ({ ...part as ContentPart }));
  const first = parts[0];
  if (first != null && first.type === 'text') {
    parts[0] = { type: 'text', text: `${block}${first.text}` };
    return parts;
  }
  return [{ type: 'text', text: block.trim() }, ...parts];
}

async function fileAttachmentContent(context: DingtalkInboundContext, media: DingtalkMediaDownload, workspace: string | null): Promise<string> {
  const label = context.fileName?.trim() || '[文件]';
  const composed = await composeContent(`[文件:${label}]`, media, workspace);
  return typeof composed === 'string' ? composed : `[文件:${label}]`;
}

export { NEW_SESSION_CONFIRM_TEXT, NEW_SESSION_FAILED_TEXT };
