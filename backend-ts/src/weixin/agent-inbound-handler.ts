import type { ContentPart, Message, Session } from '../domain/types.js';
import { isActivePhase } from '../session/session-vo.js';
import type { StreamingWsRegistry } from '../session/ws/streaming-ws-registry.js';
import { userMessagePayloadOf } from '../session/ws/streaming-ws-handler.js';
import { wsEvent } from '../session/ws/ws-event.js';
import { WsStreamingEventListener, type AgentEventListener, type WsListenerDeps } from '../session/ws/ws-streaming-event-listener.js';
import type { WeixinAccountRepository } from './account.repository.js';
import { StorageException, type WeixinFileStorageService } from './file-storage.service.js';
import type { WeixinSessionService } from './session.service.js';
import { bindWeixinSessionPeer } from './session-peer.js';
import type { InboundFile, WeixinInboundHandler, WeixinInboundMessageContext, WeixinReply } from './types.js';

const DEFAULT_IMAGE_PROMPT = '请查看这张图片';

export interface WeixinHarnessService {
  prepareMessage(sessionId: number, content: unknown): Promise<string> | string;
  execute(
    sessionId: number,
    eventId: string | null,
    listener: AgentEventListener,
    cancelFlag: { get(): boolean; set(v: boolean): void },
  ): Promise<void>;
}

export interface WeixinHandlerSessionService {
  saveMessage(sessionId: number, role: string, content: unknown, a: null, b: null, c: null, d: number, e: null): Promise<Message>;
  updatePhase(sessionId: number, phase: string): Promise<void>;
  getMessages(sessionId: number): Promise<Message[]>;
  cleanupIncompleteTail(sessionId: number): Promise<number>;
  updateContextTokens(sessionId: number, tokens: number): Promise<void>;
  /** 按会话范围回滚单条消息（消息被更新消息取代时清理孤立 USER，可选）。 */
  deleteMessageById?(sessionId: number, messageId: number): Promise<void>;
  getSession?(sessionId: number): Promise<{ phase?: string | null } | null>;
}

const FOREIGN_LOOP_WAIT_MS = 60_000;
/**
 * 桌面收尾先改阶段、再摘旗标，然后才可能排 500ms 的队列自动消费。
 * 旗标消失后还要安静超过这段延迟，才算 finally 已经开始消费或明确放弃。
 */
const FOREIGN_LOOP_QUIET_MS = 800;

type CancelFlag = { get(): boolean; set(v: boolean): void };

export interface AgentWeixinInboundHandlerDeps {
  weixinSessionService: WeixinSessionService;
  harnessService: WeixinHarnessService;
  sessionService: WeixinHandlerSessionService;
  accountRepository: WeixinAccountRepository;
  agentLoop: {
    registerCancelFlag(sessionId: number): CancelFlag;
    getCancelFlag?(sessionId: number): CancelFlag | undefined;
    requestCancel?(sessionId: number): void;
    removeCancelFlag?(sessionId: number): void;
  };
  shellSessionManager: { closeByConversation(sessionId: number): void };
  registry: StreamingWsRegistry;
  taskTerminalService: { finishExecution(sessionId: number, userId: number, phase: string, executionId: string, reason?: string): Promise<void> };
  activityService: WsListenerDeps['activityService'];
  activityHeartbeat: { touch(sessionId: number): void };
  sessionTodoMapper: {
    deleteBySessionId(sessionId: number): Promise<void>;
    selectBySessionId(sessionId: number): Promise<Array<{ id?: number; content?: string | null; status?: string | null }>>;
  };
  modelService: { getModel(id: number): Promise<{ supportsVision?: number | null } | null> };
  weixinFileStorageService: WeixinFileStorageService;
  agentExecutor?: (fn: () => Promise<void>) => void;
}

export function appendDownloadErrorNotice(body: string | null | undefined, failedNames: string[] | null | undefined): string {
  let sb = '';
  if (body != null && body.trim() !== '') sb += body;
  if (failedNames != null && failedNames.length > 0) {
    if (sb !== '') sb += '\n';
    sb += `[以下文件接收失败：${failedNames.join('、')}]`;
  }
  return sb;
}

export class AgentWeixinInboundHandler implements WeixinInboundHandler {
  static appendDownloadErrorNotice = appendDownloadErrorNotice;

  private readonly cancelFlags = new Map<number, CancelFlag>();
  private readonly generations = new Map<number, number>();
  private readonly sessionLocks = new Map<number, Promise<void>>();
  private readonly agentExecutor: (fn: () => Promise<void>) => void;
  private stopped = false;

  constructor(private readonly deps: Partial<AgentWeixinInboundHandlerDeps> = {}) {
    this.agentExecutor = deps.agentExecutor ?? ((fn) => { void fn(); });
  }

  shutdown(): void {
    this.stopped = true;
  }

  authorizeDirectMessage(_accountId: string, _fromUserId: string, _text: string): boolean {
    return true;
  }

  async onMessage(context: WeixinInboundMessageContext): Promise<WeixinReply | null> {
    const userId = await this.getUserIdFromAccountId(context.accountId);
    if (userId == null) {
      console.error(`无法获取用户ID, accountId=${context.accountId}`);
      return { text: '抱歉，系统处理出现错误，请稍后再试。' };
    }
    let session: Session;
    try {
      session = await this.deps.weixinSessionService!.getOrCreateWeixinSession(userId) as Session;
    } catch (e) {
      console.error(`获取微信会话失败, userId=${userId}`, e);
      return { text: '抱歉，处理您的消息时出现了错误，请稍后再试。' };
    }
    const sessionId = session.id!;
    bindWeixinSessionPeer(sessionId, context.fromUserId);
    const generation = this.nextGeneration(sessionId);
    this.abortRunningExecution(sessionId, userId);

    const downloadErrors = context.fileDownloadErrors ?? [];
    const files = context.files ?? [];
    const storageErrors: string[] = [];
    const saved = this.saveInboundFiles(session.workspace ?? null, files, context.imageFileNames ?? [], storageErrors);
    const savedFilePaths = saved.paths;
    const savedImagePaths = saved.imagePaths;
    const allErrors = [...downloadErrors, ...storageErrors];
    const hasSavedFiles = savedFilePaths.length > 0;
    const hasBody = context.body != null && context.body.trim() !== '';
    const hasImages = context.imageDataUris != null && context.imageDataUris.length > 0;

    if (!hasSavedFiles && !hasBody && !hasImages && allErrors.length > 0) {
      console.warn(`微信入站文件处理失败且无其他内容, sessionId=${sessionId}, errors=${allErrors.join(',')}`);
      return this.replyFileError(sessionId, allErrors, context);
    }
    if (allErrors.length > 0) {
      context.body = appendDownloadErrorNotice(context.body, allErrors);
    }

    const messageContent = this.buildMessageContent(context, savedFilePaths, savedImagePaths);
    let savedMessage: Message;
    try {
      savedMessage = await this.deps.sessionService!.saveMessage(sessionId, 'USER', messageContent, null, null, null, 0, null);
    } catch (e) {
      console.error(`保存微信用户消息失败, sessionId=${sessionId}`, e);
      return { text: '抱歉，处理您的消息时出现了错误，请稍后再试。' };
    }
    this.deps.registry?.send(userId, wsEvent('user_message_saved', sessionId, this.buildRemoteUserMessageEvent(savedMessage, messageContent)));
    const executionId = await this.deps.harnessService!.prepareMessage(sessionId, messageContent);
    return new Promise<WeixinReply | null>((resolve) => {
      this.agentExecutor(() => this.runAgent(session, userId, generation, executionId, savedMessage.id ?? null, resolve));
    });
  }

  private async runAgent(
    session: Session,
    userId: number,
    generation: number,
    executionId: string,
    savedMessageId: number | null,
    resolve: (reply: WeixinReply | null) => void,
  ): Promise<void> {
    const sessionId = session.id!;
    await this.withSessionLock(sessionId, async () => {
      if (this.stopped || !this.isCurrentGeneration(sessionId, generation)) {
        console.info(`微信消息已被更新消息取代, sessionId=${sessionId}, gen=${generation}`);
        // 本条消息已被更新的消息取代且不会被执行：回滚刚落库的 USER 消息，
        // 否则历史中留下没有回复的孤立 USER，持续污染后续 LLM 上下文。
        await this.rollbackSupersededUserMessage(sessionId, savedMessageId);
        resolve(null);
        return;
      }
      const released = await this.waitForForeignLoop(sessionId);
      if (this.stopped || !this.isCurrentGeneration(sessionId, generation)) {
        await this.rollbackSupersededUserMessage(sessionId, savedMessageId);
        resolve(null);
        return;
      }
      if (!released) {
        console.warn(`微信消息放弃执行：桌面端循环未在等待期内结束, sessionId=${sessionId}`);
        await this.rollbackSupersededUserMessage(sessionId, savedMessageId);
        resolve({ text: '当前会话仍在执行，请稍后再发。' });
        return;
      }
      const cancelFlag = this.deps.agentLoop!.registerCancelFlag(sessionId);
      this.cancelFlags.set(sessionId, cancelFlag);
      try {
        await this.deps.sessionService!.updatePhase(sessionId, 'RUNNING');
        this.deps.registry?.send(userId, wsEvent('session_status', sessionId, { phase: 'RUNNING', executionId }));
        this.deps.registry?.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
        await this.deps.sessionTodoMapper?.deleteBySessionId(sessionId);
        this.deps.registry?.send(userId, wsEvent('todo_updated', sessionId, { todos: [] }));
        const listener = new WsStreamingEventListener(
          {
            registry: this.deps.registry!,
            activityService: this.deps.activityService!,
            activityHeartbeat: this.deps.activityHeartbeat!,
            sessionTodoMapper: this.deps.sessionTodoMapper!,
            sessionService: this.deps.sessionService!,
          },
          sessionId,
          userId,
          executionId,
          await this.resolveSupportsVision(session),
        );
        await this.deps.harnessService!.execute(sessionId, null, listener, cancelFlag);
        if (cancelFlag.get() || !this.isCurrentGeneration(sessionId, generation)) {
          console.info(`微信 Agent 执行已取消, sessionId=${sessionId}, gen=${generation}`);
          await this.finishCancelledSession(sessionId, userId, executionId);
          resolve(null);
          return;
        }
        await this.deps.taskTerminalService!.finishExecution(sessionId, userId, 'COMPLETED', executionId);
        const messages = await this.deps.sessionService!.getMessages(sessionId);
        resolve({ text: this.getLatestAssistantReply(messages) });
      } catch (e) {
        if (cancelFlag.get() || !this.isCurrentGeneration(sessionId, generation)) {
          console.info(`微信 Agent 执行异常但已取消, sessionId=${sessionId}, gen=${generation}`);
          try { await this.finishCancelledSession(sessionId, userId, executionId); } catch { /* ignore */ }
          resolve(null);
          return;
        }
        console.error(`处理微信消息失败, sessionId=${sessionId}`, e);
        try {
          this.deps.registry?.send(userId, wsEvent('error', sessionId, {
            message: e instanceof Error ? e.message : 'Agent 执行异常',
            executionId,
          }));
        } catch { /* ignore */ }
        try {
          await this.deps.taskTerminalService?.finishExecution(
            sessionId, userId, 'FAILED', executionId,
            e instanceof Error ? e.message : 'Agent 执行异常',
          );
        } catch { /* ignore */ }
        resolve({ text: '抱歉，处理您的消息时出现了错误，请稍后再试。' });
      } finally {
        if (this.cancelFlags.get(sessionId) === cancelFlag) {
          this.cancelFlags.delete(sessionId);
        }
        // buildContext 在 AgentLoop.execute 之前抛出时，循环的 finally 不会摘旗标。
        // 只摘仍是本次注册的那一把，避免删掉桌面或自动消费刚换上的新旗标。
        this.releaseOwnLoopFlag(sessionId, cancelFlag);
      }
    });
  }

  private abortRunningExecution(sessionId: number, userId: number): void {
    const local = this.cancelFlags.get(sessionId);
    const loopFlag = this.deps.agentLoop?.getCancelFlag?.(sessionId);
    const flag = local ?? loopFlag;
    if (flag != null) {
      flag.set(true);
      this.deps.registry?.send(userId, wsEvent('session_status', sessionId, { phase: 'CANCELLING' }));
    }
    // 桌面端循环持有的是 AgentLoop 上那把旗标，不在本 handler 的 Map 里。
    // 必须在 registerCancelFlag 换旗之前先置位，否则旧循环看不到取消。
    if (loopFlag != null && loopFlag !== local) loopFlag.set(true);
    this.deps.agentLoop?.requestCancel?.(sessionId);
    try {
      this.deps.shellSessionManager?.closeByConversation(sessionId);
    } catch (e) {
      console.debug(`关闭微信会话 Shell 失败, sessionId=${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 桌面端（或其他非本 handler）正在跑同一会话时，先等它退出再注册新旗标。
   * 代理循环从 execute 返回时就会摘掉旗标，阶段改写和 500ms 队列自动消费都在这之后。
   * 所以「Map 里没有旗标」不算退出：阶段仍活跃、读阶段失败、或刚空闲但还没过安静窗口，都不开跑。
   */
  private async waitForForeignLoop(sessionId: number): Promise<boolean> {
    const loop = this.deps.agentLoop;
    if (loop?.getCancelFlag == null) return true;
    const own = this.cancelFlags.get(sessionId);
    const foreign = loop.getCancelFlag(sessionId);
    if (foreign === own && foreign != null) return true;
    if (foreign != null) {
      foreign.set(true);
      loop.requestCancel?.(sessionId);
    }
    const deadline = Date.now() + FOREIGN_LOOP_WAIT_MS;
    let quietSince: number | null = null;
    while (Date.now() < deadline) {
      if (this.stopped) return false;
      const current = loop.getCancelFlag(sessionId);
      const phase = await this.readPhase(sessionId);
      // 仍有别人的旗标，或阶段仍活跃：继续等。读失败不算空闲。
      if ((current != null && current !== own) || phase === 'active' || phase === 'unknown') {
        quietSince = null;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (quietSince == null) quietSince = Date.now();
      if (Date.now() - quietSince >= FOREIGN_LOOP_QUIET_MS) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 空闲阶段上挂着一把到点还没人摘的旗标，不会再被收尾清掉。留下它的话，后面每条微信都要再空等一轮。
    const stuckPhase = await this.readPhase(sessionId);
    if (stuckPhase === 'idle') this.releaseForeignFlag(sessionId, own);
    return false;
  }

  private releaseOwnLoopFlag(sessionId: number, cancelFlag: CancelFlag): void {
    const loop = this.deps.agentLoop;
    if (loop?.removeCancelFlag == null) return;
    if (loop.getCancelFlag != null && loop.getCancelFlag(sessionId) !== cancelFlag) return;
    loop.removeCancelFlag(sessionId);
  }

  private releaseForeignFlag(sessionId: number, own: CancelFlag | undefined): void {
    const loop = this.deps.agentLoop;
    if (loop?.removeCancelFlag == null || loop.getCancelFlag == null) return;
    const stuck = loop.getCancelFlag(sessionId);
    if (stuck == null || stuck === own) return;
    loop.removeCancelFlag(sessionId);
  }

  private async readPhase(sessionId: number): Promise<'active' | 'idle' | 'unknown'> {
    const sessionService = this.deps.sessionService;
    if (sessionService?.getSession == null) return 'unknown';
    try {
      const session = await sessionService.getSession(sessionId);
      if (session == null) return 'idle';
      return isActivePhase(session.phase) ? 'active' : 'idle';
    } catch {
      return 'unknown';
    }
  }

  private async rollbackSupersededUserMessage(sessionId: number, savedMessageId: number | null): Promise<void> {
    if (savedMessageId == null) return;
    try {
      await this.deps.sessionService?.deleteMessageById?.(sessionId, savedMessageId);
    } catch (e) {
      console.warn(`回滚被取代的微信用户消息失败, sessionId=${sessionId}, messageId=${savedMessageId}`, e);
    }
  }

  private async finishCancelledSession(sessionId: number, userId: number, executionId: string): Promise<void> {
    const deleted = await this.deps.sessionService!.cleanupIncompleteTail(sessionId);
    if (deleted > 0) {
      console.info(`微信会话 ${sessionId}: 取消后清理 ${deleted} 条不完整消息`);
    }
    await this.deps.taskTerminalService!.finishExecution(sessionId, userId, 'CANCELLED', executionId);
  }

  private async resolveSupportsVision(session: Session): Promise<boolean> {
    if (session.modelId == null) return false;
    try {
      const model = await this.deps.modelService!.getModel(session.modelId);
      return model != null && model.supportsVision != null && model.supportsVision === 1;
    } catch {
      return false;
    }
  }

  private buildRemoteUserMessageEvent(saved: Message, messageContent: unknown): Record<string, unknown> {
    const payload = userMessagePayloadOf(messageContent);
    return {
      messageId: saved.id,
      source: 'weixin',
      tempEventId: '',
      content: payload.content,
      ...(payload.images.length > 0 ? { images: payload.images } : {}),
    };
  }

  private nextGeneration(sessionId: number): number {
    const next = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, next);
    return next;
  }

  private isCurrentGeneration(sessionId: number, generation: number): boolean {
    return this.generations.get(sessionId) === generation;
  }

  private async withSessionLock(sessionId: number, fn: () => Promise<void>): Promise<void> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => { release = r; });
    // Map 中存链式 Promise（同 scheduled-task.service / git-write-operation.withRepoLock），
    // 清理时按同一引用比较；若与 current 比较，条件永假导致 Map 条目按 sessionId 泄漏。
    const chained = prev.then(() => current, () => current);
    this.sessionLocks.set(sessionId, chained);
    await prev;
    try {
      await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === chained) this.sessionLocks.delete(sessionId);
    }
  }

  buildMessageContent(context: WeixinInboundMessageContext, filePaths: string[], imagePaths: string[] = []): unknown {
    const imageDataUris = context.imageDataUris;
    const hasImages = imageDataUris != null && imageDataUris.length > 0;
    const hasFiles = filePaths != null && filePaths.length > 0;
    let text = context.body != null ? context.body.trim() : '';
    if (hasImages) {
      if (text === '' && !hasFiles) text = DEFAULT_IMAGE_PROMPT;
      const parts: ContentPart[] = [];
      const textParts: string[] = [];
      if (text !== '') textParts.push(text);
      if (hasFiles) {
        textParts.push(this.buildMixedText('', filePaths));
      }
      if (imagePaths != null && imagePaths.length > 0) {
        textParts.push(`图片已保存到会话工作区：${imagePaths.join('、')}`);
      }
      parts.push({ type: 'text', text: textParts.join('\n') });
      this.appendImageParts(parts, imageDataUris!);
      return parts;
    }
    if (hasFiles) return this.buildFileText(text, filePaths);
    return text;
  }

  private buildFileText(text: string, filePaths: string[]): string {
    let sb = '';
    if (text !== '') sb += `${text}\n`;
    for (const p of filePaths) sb += `@{${p}}@\n`;
    return sb.replace(/\n+$/, '');
  }

  private buildMixedText(text: string, filePaths: string[]): string {
    let sb = '';
    if (text !== '') sb += `${text}\n`;
    for (const p of filePaths) sb += `${p}\n`;
    return sb.replace(/\n+$/, '');
  }

  private appendImageParts(parts: ContentPart[], imageDataUris: string[]): void {
    for (const dataUri of imageDataUris) {
      if (dataUri == null || dataUri.trim() === '') continue;
      parts.push({ type: 'image_url', imageUrl: { url: dataUri } });
    }
  }

  private saveInboundFiles(
    workspace: string | null,
    files: InboundFile[],
    imageFileNames: string[],
    storageErrors: string[],
  ): { paths: string[]; imagePaths: string[] } {
    const paths: string[] = [];
    const imagePaths: string[] = [];
    const imageNameSet = new Set(imageFileNames);
    for (const file of files) {
      try {
        const saved = this.deps.weixinFileStorageService!.saveFile(workspace, file.fileName, file.bytes);
        console.info(`微信入站文件已保存, workspace=${workspace}, file=${saved}`);
        paths.push(saved);
        if (imageNameSet.has(file.fileName)) imagePaths.push(saved);
      } catch (e) {
        if (e instanceof StorageException) {
          console.warn(`微信入站文件保存失败, workspace=${workspace}, file=${file.fileName}: ${e.message}`);
          storageErrors.push(`${file.fileName}（${e.message}）`);
        } else {
          throw e;
        }
      }
    }
    return { paths, imagePaths };
  }

  private async replyFileError(
    sessionId: number,
    errorItems: string[],
    context: WeixinInboundMessageContext,
  ): Promise<WeixinReply> {
    const errorText = `文件接收失败：${errorItems.join('、')}，请重试`;
    try {
      await this.deps.sessionService!.saveMessage(
        sessionId, 'USER', this.buildFileMessageText(context.body, context.files),
        null, null, null, 0, null,
      );
      await this.deps.sessionService!.saveMessage(sessionId, 'ASSISTANT', errorText, null, null, null, 0, null);
    } catch (e) {
      console.warn(`记录微信文件处理失败消息失败, sessionId=${sessionId}`, e);
    }
    return { text: errorText };
  }

  private buildFileMessageText(body: string | null | undefined, files: InboundFile[] | null | undefined): string {
    let sb = '';
    if (body != null && body.trim() !== '') sb += body;
    if (files != null && files.length > 0) {
      const names = files.map((f) => f.fileName);
      if (sb !== '') sb += ' ';
      sb += `(文件: ${names.join('、')})`;
    }
    return sb;
  }

  private async getUserIdFromAccountId(accountId: string): Promise<number | null> {
    const account = await this.deps.accountRepository!.findByAccountId(accountId);
    return account?.userId ?? null;
  }

  private getLatestAssistantReply(messages: Message[] | null | undefined): string {
    if (messages == null) return '抱歉，暂时无法生成回复。';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'ASSISTANT') return messages[i].content ?? '';
    }
    return '抱歉，暂时无法生成回复。';
  }
}
