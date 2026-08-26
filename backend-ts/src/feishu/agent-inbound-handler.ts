import type { FeishuHarnessService, FeishuInboundContext, FeishuInboundHandler, FeishuReply, CancelFlag } from './types.js';
import { CompositeAgentEventListener } from '../harness/core/composite-agent-event-listener.js';
import { FeishuCardProgressListener, type FeishuCardProgress } from './card-progress-listener.js';

export interface FeishuSessionAdapter {
  getOrCreateSession(accountId: string, context: FeishuInboundContext): Promise<{ id: number; workspace?: string | null }>;
  saveUserMessage(sessionId: number, content: unknown): Promise<void>;
  getLatestAssistantReply(sessionId: number): Promise<string>;
  /** 执行前重置会话 phase（如 RUNNING），避免上一轮终态（FAILED/CANCELLED）触发 AgentLoop 取消。 */
  updatePhase?(sessionId: number, phase: string): Promise<void>;
  /** 清理取消/失败执行残留的不完整消息尾部，避免污染后续上下文。 */
  cleanupIncompleteTail?(sessionId: number): Promise<number>;
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

export class AgentFeishuInboundHandler implements FeishuInboundHandler {
  private readonly locks = new Map<number, Promise<void>>();
  private readonly cancelFlags = new Map<number, CancelFlag>();
  /** 每会话代际计数：新消息到达 +1；执行完成后若已不是最新代际则抑制回复。 */
  private readonly generations = new Map<number, number>();

  constructor(private readonly options: {
    sessionService: FeishuSessionAdapter;
    harnessService: FeishuHarnessService;
    createCancelFlag?: (sessionId: number) => CancelFlag;
    releaseCancelFlag?: (sessionId: number) => void;
    /** 新消息取消上一代执行时的回调（如关闭该会话的 shell）。 */
    onGenerationCancelled?: (sessionId: number) => void;
    /** 图片/文件下载：返回 data URI 与落盘路径；返回 null 表示无媒体或未处理。 */
    downloadMedia?: (context: FeishuInboundContext, workspace: string | null) => Promise<FeishuMediaDownload | null>;
    listenerFactory?: (sessionId: number, context: FeishuInboundContext, executionId: string) => Parameters<FeishuHarnessService['execute']>[2] | Promise<Parameters<FeishuHarnessService['execute']>[2]>;
    onExecutionFinished?: (sessionId: number, context: FeishuInboundContext, executionId: string, success: boolean) => Promise<void>;
    createProgressCard?: (context: FeishuInboundContext) => Promise<FeishuCardProgress | null>;
    onReply?: (context: FeishuInboundContext, text: string) => Promise<void>;
  }) {}

  authorizeDirectMessage(): boolean { return true; }

  async onMessage(context: FeishuInboundContext): Promise<FeishuReply | null> {
    const session = await this.options.sessionService.getOrCreateSession(context.accountId, context);
    const sessionId = session.id;
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    // 代际取消：同一会话已有消息在执行/排队时，新消息先取消上一代执行，再排队纠偏。
    // 注意：只置位上一代的 flag（对象引用），不要在等待期间注册新 flag——
    // 新 flag 会在锁内（上一代结束后）注册，避免覆盖 AgentLoop 的 session flag
    // 导致上一代的取消被 resolveCancelFlag 传播到新一代（见 weixin handler 同款时序）。
    const previousFlag = this.cancelFlags.get(sessionId);
    if (previousFlag != null) {
      previousFlag.set(true);
      this.options.onGenerationCancelled?.(sessionId);
    }
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(sessionId, queued);
    await previous;
    // 排队期间若有更新的消息到达（generation 已推进），本代已过期：不再执行 Agent，
    // 避免过期的中间消息产生工具副作用（对齐微信通道锁内 isCurrentGeneration 校验）。
    if (this.generations.get(sessionId) !== generation) {
      release();
      return null;
    }
    const cancelFlag = this.options.createCancelFlag?.(sessionId) ?? NOOP_CANCEL_FLAG;
    this.cancelFlags.set(sessionId, cancelFlag);
    let executionId = '';
    let cardListener: FeishuCardProgressListener | null = null;
    try {
      try {
        const progress = await this.options.createProgressCard?.(context) ?? null;
        if (progress != null) cardListener = new FeishuCardProgressListener(progress);
      } catch (error) {
        console.warn(`飞书进度卡片创建失败，继续执行 Agent: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 执行前重置 phase：避免上一轮 FAILED/CANCELLED 终态被 AgentLoop.isTerminalPhaseInDb 判定为取消。
      await this.options.sessionService.updatePhase?.(sessionId, 'RUNNING');
      const message = await this.buildMessage(context, session.workspace ?? null);
      await this.options.sessionService.saveUserMessage(sessionId, message);
      const eventId = await this.options.harnessService.prepareMessage(sessionId, message);
      executionId = eventId || '';
      const listener = await this.options.listenerFactory?.(sessionId, context, executionId);
      if (listener == null) throw new Error('Feishu listenerFactory is required to execute a harness session');
      await this.options.harnessService.execute(
        sessionId, eventId || null,
        cardListener == null ? listener : CompositeAgentEventListener.of(listener, cardListener),
        cancelFlag,
      );
      // 被代际取消（本代 flag 被置位或已有更新的消息排队）时不回复，并清理残留消息尾部。
      if (cancelFlag.get() || this.generations.get(sessionId) !== generation) {
        await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
        const cardUpdated = await cardListener?.cancel();
        await this.options.onExecutionFinished?.(sessionId, context, executionId, false);
        if (cardListener == null || cardUpdated !== false) return null;
        return { text: '任务已取消。' };
      }
      await this.options.onExecutionFinished?.(sessionId, context, executionId, true);
      const text = await this.options.sessionService.getLatestAssistantReply(sessionId);
      const cardUpdated = await cardListener?.complete(text);
      if (cardListener == null || cardUpdated === false) {
        await this.options.onReply?.(context, text);
        return { text };
      }
      return null;
    } catch (error) {
      // 前置步骤或 Agent 执行失败：不向长连接冒泡，向用户回友好文案并标记失败。
      console.error(`飞书 Agent 执行失败, sessionId=${sessionId}`, error);
      await this.options.sessionService.cleanupIncompleteTail?.(sessionId);
      const cardUpdated = await cardListener?.fail('抱歉，处理您的消息时出现了错误，请稍后再试。');
      await this.options.onExecutionFinished?.(sessionId, context, executionId, false);
      return cardListener == null || cardUpdated === false ? { text: '抱歉，处理您的消息时出现了错误，请稍后再试。' } : null;
    } finally {
      release();
      if (this.locks.get(sessionId) === queued) {
        this.locks.delete(sessionId);
        if (this.cancelFlags.get(sessionId) === cancelFlag) {
          this.cancelFlags.delete(sessionId);
          this.options.releaseCancelFlag?.(sessionId);
        }
        if (this.generations.get(sessionId) === generation) this.generations.delete(sessionId);
      }
    }
  }

  private async buildMessage(context: FeishuInboundContext, workspace: string | null): Promise<string | FeishuContentPart[]> {
    const text = context.groupContext == null
      ? context.text
      : `[群聊上下文，以下为群内最近讨论]\n${context.groupContext}\n---\n（触发者${context.senderLabel ?? '未知用户'}）请基于上面讨论继续处理：${context.text}`;
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
}
