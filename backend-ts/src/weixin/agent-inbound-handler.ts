import type { ContentPart, Message, Session } from '../domain/types.js';
import type { StreamingWsRegistry } from '../session/ws/streaming-ws-registry.js';
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
}

export interface AgentWeixinInboundHandlerDeps {
  weixinSessionService: WeixinSessionService;
  harnessService: WeixinHarnessService;
  sessionService: WeixinHandlerSessionService;
  accountRepository: WeixinAccountRepository;
  agentLoop: { registerCancelFlag(sessionId: number): { get(): boolean; set(v: boolean): void } };
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

  private readonly cancelFlags = new Map<number, { get(): boolean; set(v: boolean): void }>();
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
      this.agentExecutor(() => this.runAgent(session, userId, generation, executionId, resolve));
    });
  }

  private async runAgent(
    session: Session,
    userId: number,
    generation: number,
    executionId: string,
    resolve: (reply: WeixinReply | null) => void,
  ): Promise<void> {
    const sessionId = session.id!;
    await this.withSessionLock(sessionId, async () => {
      if (this.stopped || !this.isCurrentGeneration(sessionId, generation)) {
        console.info(`微信消息已被更新消息取代, sessionId=${sessionId}, gen=${generation}`);
        resolve(null);
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
      }
    });
  }

  private abortRunningExecution(sessionId: number, userId: number): void {
    const flag = this.cancelFlags.get(sessionId);
    if (flag != null) {
      flag.set(true);
      this.deps.registry?.send(userId, wsEvent('session_status', sessionId, { phase: 'CANCELLING' }));
    }
    try {
      this.deps.shellSessionManager?.closeByConversation(sessionId);
    } catch (e) {
      console.debug(`关闭微信会话 Shell 失败, sessionId=${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
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
    const data: Record<string, unknown> = {
      messageId: saved.id,
      source: 'weixin',
      tempEventId: '',
    };
    if (typeof messageContent === 'string') {
      data.content = messageContent;
      return data;
    }
    if (Array.isArray(messageContent)) {
      let text = '';
      const images: string[] = [];
      for (const part of messageContent as ContentPart[]) {
        if (part.type === 'text' && part.text != null) text += part.text;
        else if (part.type === 'image_url' && part.imageUrl?.url != null) images.push(part.imageUrl.url);
      }
      data.content = text;
      if (images.length > 0) data.images = images;
      return data;
    }
    data.content = saved.content ?? '';
    return data;
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
    this.sessionLocks.set(sessionId, prev.then(() => current));
    await prev;
    try {
      await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) this.sessionLocks.delete(sessionId);
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
