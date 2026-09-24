import { randomUUID } from 'node:crypto';
import { FeishuCardProgressListener, countCompletedAgentRounds, type FeishuCardProgress } from '../feishu/card-progress-listener.js';
import { CompositeAgentEventListener } from '../harness/core/composite-agent-event-listener.js';
import { NoopAgentEventListener } from '../harness/core/agent-event-listener.js';
import { userMessagePayloadOf } from '../session/ws/streaming-ws-handler.js';
import { wsEvent } from '../session/ws/ws-event.js';
import type { StreamingWsRegistry } from '../session/ws/streaming-ws-registry.js';
import { isInboundFileMessage, isNewSessionCommand } from './event-normalizer.js';
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
  finalizeNewSessionTitle?(sessionId: number, title: string): Promise<boolean>;
}

const NEW_SESSION_CONFIRM_TEXT = '已开启新会话，后续消息将在新的上下文中处理。';
const NEW_SESSION_FAILED_TEXT = '开启新会话失败，请稍后再试。';
const NEW_SESSION_TITLE_MAX_CHARS = 20;
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
    onExecutionFinished?: (sessionId: number, context: DingtalkInboundContext, executionId: string, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>;
    /** 回复发出之后再清进度卡映射，便于发送失败时把原因写回卡片。 */
    afterDelivery?: (sessionId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>;
    /** 失败重试没有入站上下文，按进度卡映射还原发送目标。 */
    resolveReplyContext?: (sessionId: number) => Promise<DingtalkInboundContext | null>;
    createProgressCard?: (context: DingtalkInboundContext, sessionId: number) => Promise<FeishuCardProgress | null>;
    queueService?: DingtalkTaskQueuePort;
    createQueueCard?: (context: DingtalkInboundContext, queueId: number, sessionId: number) => Promise<string | null>;
    resolveBotId?: (accountId: string) => number;
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
    const session = await this.options.sessionService.getOrCreateSession(context.accountId, context);
    return this.executeWithSession(session, context);
  }

  private async onP2pMessage(context: DingtalkInboundContext): Promise<DingtalkReply | null> {
    const outcome = await this.withP2pChatLock(context, async (): Promise<P2pOutcome> => {
      if (isNewSessionCommand(context.text)) return this.openNewSession(context);
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

  private async openNewSession(context: DingtalkInboundContext): Promise<P2pOutcome> {
    const control = this.options.p2pSessionControl!;
    const active = await control.findActiveSession(context.accountId, context);
    if (active != null) {
      this.abandoned.add(active.id);
      this.cancel(active.id);
      await this.options.settleCancel?.(active.id);
      await this.dropQueued(active.id);
    }
    try {
      const created = await control.createSession(context.accountId, context);
      return { intercepted: true, confirm: NEW_SESSION_CONFIRM_TEXT, sessionId: created.id };
    } catch (error) {
      console.error(`钉钉私聊新建会话失败, accountId=${context.accountId}, messageId=${context.messageId}`, error);
      return { intercepted: true, confirm: NEW_SESSION_FAILED_TEXT };
    }
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
        await cardListener?.cancel(wasInterrupted);
        await this.options.onExecutionFinished?.(sessionId, context, executionId, 'CANCELLED');
        return { text: cardListener == null ? (wasInterrupted ? '任务已被下一条消息中断。' : '任务已取消。') : null, phase: 'CANCELLED' };
      }
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      await cardListener?.complete(text);
      return { text, phase: 'COMPLETED' };
    } catch (error) {
      console.error(`钉钉 Agent 执行失败, sessionId=${sessionId}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      const failText = error instanceof Error ? error.message : 'Agent 执行异常';
      await cardListener?.fail(failText);
      await this.options.onExecutionFinished?.(sessionId, context, executionId, 'FAILED');
      return { text: failText, phase: 'FAILED' };
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
      await this.options.harnessService.execute(sessionId, null, CompositeAgentEventListener.of(listener, cardListener), cancelFlag);
      if (cancelFlag.get()) {
        await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
        await cardListener.cancel(this.interrupted.has(sessionId));
        await this.options.onExecutionFinished?.(sessionId, stub, executionId, 'CANCELLED');
        await this.options.afterDelivery?.(sessionId, 'CANCELLED');
        return 'CANCELLED';
      }
      await this.options.onExecutionFinished?.(sessionId, stub, executionId, 'COMPLETED');
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      await cardListener.complete(text);
      if (text) await this.reply(await this.replyContext(sessionId, stub), text, sessionId);
      await this.options.afterDelivery?.(sessionId, 'COMPLETED');
      return 'COMPLETED';
    } catch (error) {
      const failText = error instanceof Error ? error.message : 'Agent 执行异常';
      await cardListener?.fail(failText);
      await this.options.onExecutionFinished?.(sessionId, stub, '', 'FAILED');
      if (failText) await this.reply(await this.replyContext(sessionId, stub), failText, sessionId);
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
    let queueId: number;
    try {
      queueId = await queueService.enqueue({
        sessionId, botId, messageId: context.messageId, senderUserid: context.senderUserid ?? '',
        maoUserId: session.executionUserId ?? context.maoUserId ?? null, payload,
      });
    } catch (error) {
      console.error(`钉钉消息入队失败, sessionId=${sessionId}`, error);
      await this.reply(context, '当前任务正在执行中，消息排队失败，请稍后重试。', sessionId);
      return;
    }
    const outTrackId = await this.options.createQueueCard?.(context, queueId, sessionId).catch(() => null) ?? null;
    if (outTrackId != null) await queueService.setOutTrackId(queueId, outTrackId);
    else await this.reply(context, '当前任务执行中，你的消息已排队等待处理。', sessionId);
  }

  private async drainNext(sessionId: number, executionUserId: number | null): Promise<'COMPLETED' | 'CANCELLED' | 'FAILED' | null> {
    const queueService = this.options.queueService;
    return this.withLock(sessionId, async () => {
      if (await this.isBusyOrRecovering(sessionId)) return null;
      if (this.hasPendingAttachments(sessionId)) await this.persistPendingAttachments(sessionId, executionUserId);
      if (queueService == null) return null;
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
    const phase = this.options.sessionService.getPhase == null ? null : await this.options.sessionService.getPhase(sessionId).catch(() => null);
    return phase === 'RUNNING' || phase === 'RESUMING';
  }

  private async buildMessage(context: DingtalkInboundContext, workspace: string | null): Promise<BuiltMessage> {
    const sections: string[] = [];
    const quoted = context.quotedText?.trim();
    if (quoted) sections.push(`【引用的消息】\n${quoted}`);
    if (context.chatType === 'group') sections.push(`【用户消息】\n${context.senderLabel?.trim() || context.senderName}：${context.text}`);
    else sections.push(context.text);
    const persistedText = sections.join('\n\n');
    const media = await this.options.downloadMedia?.(context, workspace) ?? null;
    const persisted = media == null ? persistedText : composeContent(persistedText, media);
    const group = context.groupContext?.trim();
    if (group == null || group === '') return { persisted, forModel: persisted };
    const forModel = prependGroup(persisted, group);
    return { persisted, forModel };
  }

  private ingestFileWithoutExecute(session: DingtalkSessionRef, context: DingtalkInboundContext): Promise<void> {
    return this.runFileIngest(session.id, async () => {
      const media = await this.options.downloadMedia?.(context, session.workspace ?? null) ?? { images: [], imagePaths: [], filePaths: [], errors: [] };
      const content = fileAttachmentContent(context, media);
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

function contextFromQueue(payload: DingtalkQueuePayload, row: DingtalkInboundQueueRow): DingtalkInboundContext {
  const s = payload.context;
  return {
    accountId: s.accountId, chatType: s.chatType, conversationId: s.conversationId, messageId: s.messageId,
    senderUserid: s.senderUserid, senderUnionId: s.senderUnionId, senderName: s.senderName,
    msgtype: s.msgtype, text: s.text, downloadCodes: [], fileName: s.fileName, quotedText: s.quotedText ?? null,
    isInAtList: true, maoUserId: row.maoUserId ?? s.maoUserId, groupContext: s.groupContext, senderLabel: s.senderLabel,
  };
}

function composeContent(text: string, media: DingtalkMediaDownload): string | ContentPart[] {
  let body = text;
  if (media.errors.length > 0) {
    const notice = `[以下文件接收失败：${media.errors.join('、')}]`;
    body = body.trim() === '' ? notice : `${body}\n${notice}`;
  }
  if (media.filePaths.length > 0) {
    const refs = media.filePaths.map((path) => `@{${path}}@`).join('\n');
    body = body.trim() === '' ? refs : `${body}\n${refs}`;
  }
  if (media.imagePaths.length > 0) {
    const hint = `图片已保存到会话工作区：${media.imagePaths.join('、')}`;
    body = body.trim() === '' ? hint : `${body}\n${hint}`;
  }
  if (media.images.length === 0) return body;
  const parts: ContentPart[] = [{ type: 'text', text: body.trim() === '' ? '请查看图片' : body }];
  for (const uri of media.images) parts.push({ type: 'image_url', imageUrl: { url: uri } });
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

function fileAttachmentContent(context: DingtalkInboundContext, media: DingtalkMediaDownload): string {
  const label = context.fileName?.trim() || '[文件]';
  const composed = composeContent(`[文件:${label}]`, media);
  return typeof composed === 'string' ? composed : `[文件:${label}]`;
}

export { NEW_SESSION_CONFIRM_TEXT, NEW_SESSION_FAILED_TEXT };
