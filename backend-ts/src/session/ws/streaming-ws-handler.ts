import { randomUUID } from 'node:crypto';
import type { Agent, ContentPart, LlmModel, LocalSkillRef, Message, MessageQueueItem, McpToolRef, Session } from '../../domain/types.js';
import type { JwtService } from '../../crypto/jwt.service.js';
import { contentParts, WsStreamingEventListener, type AgentEventListener, type WsListenerDeps } from './ws-streaming-event-listener.js';
import type { StreamingWsRegistry, WsSocket } from './streaming-ws-registry.js';
import { wsEvent } from './ws-event.js';
import { isActivePhase } from '../session-vo.js';
import type { EmbedPageToolRegistry } from '../../harness/embed-page-tool-registry.js';

export interface WsHandlerDeps {
  registry: StreamingWsRegistry;
  titleService: {
    scheduleForFirstUserMessage(sessionId: number, messageId: number | null | undefined, content: unknown): void;
  };
  harnessService: {
    prepareMessage(sessionId: number, content: unknown): Promise<string> | string;
    executeFromEvent(sessionId: number, eventId: string, listener: AgentEventListener, cancelFlag: { get(): boolean; set(v: boolean): void }): Promise<void>;
    executeSideFirstMessage(parentId: number, sideId: number, inherit: boolean, listener: AgentEventListener, cancelFlag: { get(): boolean; set(v: boolean): void }): Promise<void>;
  };
  sessionService: {
    getSession(id: number): Promise<Session | null>;
    saveMessage(sessionId: number, role: string, content: unknown, a: null, b: null, c: null, d: number, e: null): Promise<Message>;
    updatePhase(sessionId: number, phase: string): Promise<void>;
    updateField(sessionId: number, field: string, value: unknown): Promise<void>;
    updateModelId(sessionId: number, modelId: number): Promise<void>;
    getMessages(sessionId: number): Promise<Message[]>;
    getLastUserMessage(sessionId: number): Promise<Message | null>;
    editMessageAndTruncate(sessionId: number, messageId: number, content: string, images: string[]): Promise<Message>;
    deleteMessageById(sessionId: number, messageId: number): Promise<void>;
    save(session: Session): Promise<void>;
    listSubagentSessions(parentId: number): Promise<Session[]>;
    cleanupIncompleteTail(sessionId: number): Promise<number>;
    updateContextTokens(sessionId: number, tokens: number): Promise<void>;
  };
  taskTerminalService: {
    finishExecution(sessionId: number, userId: number, phase: string, executionId: string, reason?: string): Promise<void>;
  };
  messageQueueService: {
    listPending(sessionId: number): Promise<MessageQueueItem[]>;
    enqueue(sessionId: number, userId: number, content: string, images: string | null, scheduledTaskId?: number | null): Promise<void>;
    enqueueHead(sessionId: number, userId: number, content: string, images: string | null, scheduledTaskId?: number | null): Promise<void>;
    dequeue(sessionId: number): Promise<MessageQueueItem | null>;
    getById(id: number): Promise<MessageQueueItem | null>;
    delete(id: number): Promise<void>;
    reorder(id: number, direction: string): Promise<void>;
  };
  /** busy 入队的定时任务在队列真正执行完成后回写 lastExecutionStatus */
  onScheduledTaskQueueConsumed?: (taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void> | void;
  embedPageToolRegistry: EmbedPageToolRegistry;
  localToolSessionRegistry: {
    setUserForSession(sessionId: number, userId: number): void;
    isConnected(sessionId: number): boolean | Promise<boolean>;
    failAllForSession(sessionId: number): void;
    failAllForUser(userId: number): void;
    completeToolRequest(sessionId: number, requestId: string, result: string): void;
    completeToolRequestError(sessionId: number, requestId: string, error: string): void;
  };
  askUserQuestionsRegistry: {
    failAllForSession(sessionId: number): void;
    getPendingForSession(sessionId: number): Array<{ requestId: string; questions: unknown[]; metadata?: unknown }>;
    complete(sessionId: number, requestId: string, resultJson: string): boolean;
  };
  treeSignalPublisher: {
    publishIfSideTask(sessionId: number): void;
    publishForSession(sessionId: number): void | Promise<void>;
  };
  approvalRegistry: {
    unregister(sessionId: number | null, requestId: string | null): void | Promise<void>;
  };
  activityService: WsListenerDeps['activityService'];
  activityHeartbeat: { touch(sessionId: number): void; clear(sessionId: number): void };
  sessionTodoMapper: {
    deleteBySessionId(sessionId: number): Promise<void>;
    selectBySessionId(sessionId: number): Promise<Array<{ id?: number; content?: string | null; status?: string | null }>>;
  };
  agentLoop: {
    registerCancelFlag(sessionId: number): { get(): boolean; set(v: boolean): void };
    removeCancelFlag(sessionId: number): void;
    requestCancel(sessionId: number): void;
  };
  backgroundSubagentManager?: {
    cancelAllForParent(parentSessionId: number): Promise<void>;
    beginRetry(parentSessionId: number, childSessionId: number): Promise<{ ok: boolean; taskId?: number; error?: string }>;
    completeRetry(parentSessionId: number, taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void>;
  };
  shellSessionManager: { closeByConversation(sessionId: number): void };
  skillSyncService: {
    syncToSession(agent: Agent, userId: number, sessionId: number): Promise<void>;
    getRemovedSkillNames(agent: Agent, userId: number, sessionId: number): string[];
  };
  localSkillRegistry: {
    report(sessionId: number, skills: LocalSkillRef[]): void;
    clear(sessionId: number): void;
  };
  localAgentsMdRegistry: {
    report(sessionId: number, content: string | null): void;
    clear(sessionId: number): void;
  };
  mcpSyncService: {
    loadAgentServers(agent: Agent, userId: number): Promise<Array<{ name: string }>>;
    buildSyncPayload(servers: Array<{ name: string }>): Record<string, unknown>;
    clearSession(sessionId: number): void;
    resolveServerIdByName(name: string): number | null;
    recordReport(sessionId: number, tools: McpToolRef[]): void;
  };
  mcpClientManager: { closeSession(sessionId: number): void };
  agentMapper: { selectById(id: number): Promise<Agent | null> };
  llmModelMapper: {
    selectById(id: number): Promise<LlmModel | null>;
    selectDefault(): Promise<LlmModel | null>;
  };
  jwtService: JwtService;
  agentExecutor: (fn: () => void | Promise<void>) => unknown;
  mcpSyncTimeoutSeconds?: number;
}

function cancelFlag(): { get(): boolean; set(v: boolean): void } {
  let v = false;
  return { get: () => v, set: (n) => { v = n; } };
}

export class StreamingWsHandler {
  private readonly cancelFlags = new Map<number, { get(): boolean; set(v: boolean): void }>();
  private readonly runningTasks = new Map<number, unknown>();
  private readonly runningExecutionIds = new Map<number, string>();
  private readonly executionClaims = new Set<number>();
  private readonly sessionLocks = new Map<number, Promise<void>>();
  private readonly pendingSkillSyncs = new Map<number, { syncId: string; resolve: () => void; reject: (e: Error) => void }>();
  private readonly pendingMcpSyncs = new Map<number, { syncId: string; resolve: () => void; reject: (e: Error) => void }>();
  private readonly autoConsumingSessionIds = new Set<number>();
  private readonly suppressAutoConsumeSend = new Set<number>();
  /** 用户已点「停止」但 cancel flag 尚未注册（执行提交前的窗口期）的会话 → 登记时间戳；注册标志时按时间判定消费。 */
  private readonly pendingCancels = new Map<number, number>();
  private readonly insertLocks = new Map<number, Promise<void>>();
  /** autoConsume 消费到的定时任务来源：sessionId → scheduledTaskId，执行终态后回写 */
  private readonly queueScheduledTaskIds = new Map<number, number>();
  private readonly mcpSyncTimeoutSeconds: number;

  constructor(private readonly deps: WsHandlerDeps) {
    this.mcpSyncTimeoutSeconds = deps.mcpSyncTimeoutSeconds ?? 60;
  }

  hasExecutionClaim(sessionId: number): boolean {
    return this.executionClaims.has(sessionId) || this.runningTasks.has(sessionId);
  }

  afterConnectionClosed(session: WsSocket): void {
    const userId = this.deps.registry.getUserId(session);
    // 页面连接断开：先让该连接上所有等待中的页面工具立即失败，再注销连接与绑定。
    for (const boundSessionId of this.deps.registry.getEmbedSessionsForConnection(session)) {
      this.deps.embedPageToolRegistry.failSession(boundSessionId, '页面连接已断开，页面操作已取消', 'embed_client_not_connected');
    }
    this.deps.registry.unregister(session);
    if (userId != null && !this.deps.registry.hasLocalClientConnection(userId)) {
      this.deps.localToolSessionRegistry.failAllForUser(userId);
    }
  }

  handleTransportError(session: WsSocket): void {
    this.afterConnectionClosed(session);
  }

  async handleTextMessage(session: WsSocket, payload: string): Promise<void> {
    if (!this.deps.registry.isConnectionAuthorized(session)) return;
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!root || typeof root !== 'object') return;
    const type = typeof root.type === 'string' ? root.type : null;
    if (!type) return;
    // 鉴权改为首帧 auth 消息：token 不再出现在握手 URL（避免进日志/代理记录）。
    // 未注册连接仅接受 auth 帧；其余消息 fail fast 关闭，防止无凭据占用连接。
    const userId = this.deps.registry.getUserId(session);
    if (userId == null) {
      if (type !== 'auth') {
        this.deps.registry.closeConnection(session, 'Not authenticated');
        return;
      }
      const token = typeof root.token === 'string' ? root.token : undefined;
      const metadata = token ? this.deps.jwtService.getAccessTokenMetadata(token) : null;
      if (!metadata || (metadata.authSource === 'company_sso' && this.deps.jwtService.getTokenType(token!) !== 'access')) {
        this.deps.registry.closeConnection(session, 'Missing or invalid token');
        return;
      }
      const clientType = this.normalizeClient(typeof root.client === 'string' ? root.client : undefined);
      this.deps.registry.register(session, metadata.userId, clientType, metadata);
      this.deps.registry.sendToConnection(session, wsEvent('connected', null, { userId: metadata.userId }));
      return;
    }
    if (type === 'auth_refresh') {
      this.handleAuthRefresh(session, root);
      return;
    }
    try {
      await this.dispatch(session, userId, type, root);
    } catch (e) {
      console.error(`WS handler failed for type=${type} userId=${userId}`, e);
    }
  }

  private async dispatch(session: WsSocket, userId: number, type: string, root: Record<string, unknown>): Promise<void> {
    switch (type) {
      case 'subscribe': await this.handleSubscribe(session, userId, root); break;
      case 'unsubscribe': this.handleUnsubscribe(session, userId, root); break;
      case 'send_message': await this.handleSendMessage(userId, root, true); break;
      case 'edit_and_resend': await this.handleEditAndResend(userId, root); break;
      case 'cancel': await this.handleCancel(userId, root); break;
      case 'enqueue_message': await this.handleEnqueueMessage(userId, root); break;
      case 'insert_message': await this.handleInsertMessage(userId, root); break;
      case 'delete_queue_message': await this.handleDeleteQueueMessage(userId, root); break;
      case 'reorder_queue_message': await this.handleReorderQueueMessage(userId, root); break;
      case 'skill_sync_done': await this.handleSkillSyncDone(userId, root); break;
      case 'mcp_tools_report': await this.handleMcpToolsReport(userId, root); break;
      case 'tool_result': await this.handleToolResult(userId, root); break;
      case 'tool_error': await this.handleToolError(userId, root); break;
      case 'page_tool_result': await this.handlePageToolResult(session, userId, root); break;
      case 'tool_approval': await this.handleToolApproval(userId, root); break;
      case 'ask_user_questions_result': await this.handleAskUserQuestionsResult(userId, root); break;
      case 'create_side_session': await this.handleCreateSideSession(userId, root); break;
      case 'cancel_side_task': await this.handleCancelSideTask(userId, root); break;
      case 'retry_execution': await this.handleRetryExecution(userId, root); break;
      case 'ping': this.deps.registry.send(userId, wsEvent('pong', null, {})); break;
      default: break;
    }
  }

  private async handleSubscribe(session: WsSocket, userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    const s = await this.requireOwnedSession(userId, sessionId);
    if (!s) return;
    this.deps.registry.subscribe(userId, sessionId);
    // 页面执行端绑定：embed 连接订阅 agent 会话后，该会话的页面工具请求只发往此连接。
    if (this.deps.registry.getClientType(session) === 'embed') {
      const previous = this.deps.registry.getEmbedSessionBinding(sessionId);
      if (previous && previous.id !== session.id) {
        // 同一会话被新标签页/新连接接管：旧连接上在途的页面请求立即失败，
        // 即使旧连接已不 OPEN 也要清掉，否则它会堵住该会话的串行队列直到超时。
        this.deps.embedPageToolRegistry.failSession(sessionId, '页面连接已切换，页面操作已取消', 'embed_client_not_connected');
        // 旧连接可能仍 OPEN 并在本地继续执行在途 DOM 动作；显式通知它中止，避免与新连接重复执行。
        this.deps.registry.sendToConnection(previous, wsEvent('page_tool_cancel', sessionId, { reason: '页面连接已切换' }));
      }
      this.deps.registry.bindEmbedSession(sessionId, session);
    }
    const active = this.isSessionActive(s.phase);
    if (s.executionMode === 'LOCAL' && active) {
      this.deps.localToolSessionRegistry.setUserForSession(sessionId, userId);
    }
    // 订阅既是流式事件通道，也是客户端断线后的状态校准点。即使任务已结束，
    // 也必须回传终态，避免完成事件恰好在断线期间丢失后界面永久停在“执行中”。
    const executionId = this.runningExecutionIds.get(sessionId);
    this.deps.registry.send(userId, wsEvent('session_snapshot', sessionId, {
      phase: s.phase === 'RESUMING' ? 'RUNNING' : s.phase,
      ...(executionId ? { executionId } : {}),
    }));
    if (active) {
      for (const toolCall of this.deps.registry.getActiveToolCalls(sessionId)) {
        this.deps.registry.send(userId, wsEvent('tool_call_start', sessionId, toolCall));
      }
      for (const pq of this.deps.askUserQuestionsRegistry.getPendingForSession(sessionId)) {
        const payload: Record<string, unknown> = { requestId: pq.requestId, questions: pq.questions ?? [] };
        if (pq.metadata != null) payload.metadata = pq.metadata;
        this.deps.registry.send(userId, wsEvent('ask_user_questions', sessionId, payload));
      }
    }
  }

  private handleUnsubscribe(session: WsSocket, userId: number, root: Record<string, unknown>): void {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    this.deps.registry.unsubscribe(userId, sessionId);
    if (this.deps.registry.getClientType(session) === 'embed'
      && this.deps.registry.getEmbedSessionsForConnection(session).includes(sessionId)) {
      // 页面端主动退订（切换/新建会话）：在途页面请求立即失败，不等超时。
      this.deps.embedPageToolRegistry.failSession(sessionId, '页面已取消订阅，页面操作已取消', 'embed_client_not_connected');
      this.deps.registry.unbindEmbedSession(sessionId, session);
    }
  }

  private async handleSendMessage(userId: number, root: Record<string, unknown>, clearTodos: boolean): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    const data = (root.data ?? {}) as Record<string, unknown>;
    // claimAlreadyHeld=true 表示调用方（auto-consume）已在出队前占位会话，
    // 本方法内任何未进入执行的失败出口都必须释放占位，否则会话永久卡死
    const claimAlreadyHeld = data.executionClaimHeld === true;
    // auto-consume / 插队路径的消息在调用本方法前已落库：校验失败回补队首时须一并删除孤儿消息，
    // 否则下次消费会再写一条同内容 USER 消息（重复落库）。
    const autoSavedMessageId = typeof data.autoSavedMessageId === 'number' ? data.autoSavedMessageId : null;
    if (typeof data.content !== 'string') {
      if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
      return;
    }
    const content = data.content;
    const eventId = typeof data.eventId === 'string' ? data.eventId : null;
    const images = Array.isArray(data.images) ? data.images.map(String) : [];
    // 本次发送的起始时间：pendingCancels 只消费「登记时间晚于本次发送开始」的取消标记，
    // 避免此前一次取消（当时无执行在跑）残留的标记误杀用户后续的新发送。
    // autoConsume 必须取「占位/出队时刻」而非本方法入口：500ms 延迟窗口内的取消
    // 登记时间早于入口，若用入口时间会被误判为陈旧标记而丢弃（M-2 回归）。
    const autoConsumeStartedAt = typeof data.autoConsumeStartedAt === 'number' ? data.autoConsumeStartedAt : null;
    const sendStartedAt = autoConsumeStartedAt != null ? autoConsumeStartedAt : Date.now();
    const session = await this.requireOwnedSession(userId, sessionId);
    if (!session) {
      if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
      return;
    }
    const replacingExecution = data.replaceExecution === true;
    const isAutoConsume = this.autoConsumingSessionIds.delete(sessionId);
    /** 自动消费的消息已出队并落库，任何未进入执行的早退都必须回补队首，否则消息永不执行 */
    const requeueIfClaimed = async () => {
      if (!claimAlreadyHeld) return;
      this.executionClaims.delete(sessionId);
      // 回补即放弃本次消费：清掉定时任务绑定，避免下次无关执行误回写陈旧任务终态
      const scheduledTaskId = this.queueScheduledTaskIds.get(sessionId) ?? null;
      this.queueScheduledTaskIds.delete(sessionId);
      if (autoSavedMessageId != null) {
        try {
          await this.deps.sessionService.deleteMessageById(sessionId, autoSavedMessageId);
        } catch (e) {
          console.error(`Failed to delete orphan auto-saved message ${autoSavedMessageId} for session ${sessionId}`, e);
        }
      }
      try {
        await this.deps.messageQueueService.enqueueHead(
          sessionId, userId, content, images.length > 0 ? JSON.stringify(images) : null, scheduledTaskId,
        );
        await this.sendQueueUpdated(sessionId, userId);
      } catch (e) {
        console.error(`Failed to re-enqueue auto-consumed message for session ${sessionId}`, e);
      }
    };
    if (!replacingExecution && !isAutoConsume && this.isSessionActive(session.phase)) {
      this.sendSessionAlreadyRunning(userId, sessionId);
      return;
    }
    if (data.modelId != null) {
      const newModelId = Number(data.modelId);
      if (newModelId !== session.modelId) {
        await this.deps.sessionService.updateModelId(sessionId, newModelId);
        session.modelId = newModelId;
      }
    }
    if (images.length > 0) {
      const model = await this.resolveSessionModel(session);
      if (!model || model.supportsVision !== 1) {
        await requeueIfClaimed();
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '当前模型不支持图片输入，请切换支持视觉的模型' }));
        return;
      }
      if (images.length > 10) {
        await requeueIfClaimed();
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '单条消息最多支持 10 张图片', }));
        return;
      }
    }
    if (!claimAlreadyHeld && this.executionClaims.has(sessionId)) {
      this.sendSessionAlreadyRunning(userId, sessionId);
      return;
    }
    if (!claimAlreadyHeld) this.executionClaims.add(sessionId);
    if (session.executionMode === 'LOCAL') {
      this.deps.localToolSessionRegistry.setUserForSession(sessionId, userId);
      if (!(await this.deps.localToolSessionRegistry.isConnected(sessionId))) {
        await requeueIfClaimed();
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: 'Local client is not connected. Please ensure the desktop app is running.' }));
        return;
      }
      this.deps.localSkillRegistry.report(sessionId, this.parseLocalSkills(data.localSkills));
      this.deps.localAgentsMdRegistry.report(sessionId, typeof data.agentsMdContent === 'string' ? data.agentsMdContent : null);
    }
    const messageContent: unknown = images.length === 0 ? content : contentParts(content, images);
    if (!isAutoConsume) {
      try {
        const savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, null, null, null, 0, null);
        this.deps.titleService.scheduleForFirstUserMessage(sessionId, savedMessage.id, messageContent);
        this.deps.registry.send(userId, wsEvent('user_message_saved', sessionId, { tempEventId: eventId ?? '', messageId: savedMessage.id }));
      } catch (e) {
        // M-4：claim 添加后、执行提交前的异常路径必须释放占位，否则会话永久判定 busy。
        this.executionClaims.delete(sessionId);
        this.pendingCancels.delete(sessionId);
        if (claimAlreadyHeld) {
          await requeueIfClaimed().catch((requeueErr) => {
            console.error(`Failed to re-enqueue auto-consumed message for session ${sessionId}`, requeueErr);
          });
        }
        throw e;
      }
    }
    const resolvedEventId = eventId && eventId.trim() !== '' ? eventId : await this.deps.harnessService.prepareMessage(sessionId, messageContent);
    // 注册 cancel flag 前消费窗口期内到达的「停止」请求（M-2 竞态修复）：
    // 注册完成后回调在下一个微任务执行，但此刻仍在同一同步段内，
    // 通过注册时返回值立即消费，避免用户点「停止」后任务照常跑完。
    const flag = this.deps.agentLoop.registerCancelFlag(sessionId);
    const pendingCancelAt = this.pendingCancels.get(sessionId);
    this.pendingCancels.delete(sessionId);
    if (pendingCancelAt != null && pendingCancelAt >= sendStartedAt) {
      // 用户已在执行提交前点「停止」：释放占位并落 CANCELLED 终态，不提交执行。
      // 早于本次发送开始的残留标记（上次取消的遗留）在此被静默清除，不影响本次发送。
      flag.set(true);
      this.executionClaims.delete(sessionId);
      this.autoConsumingSessionIds.delete(sessionId);
      this.runningExecutionIds.delete(sessionId);
      // 定时任务 busy 入队消息在此窗口被取消：同步回写 CANCELLED 并清映射，避免永久 QUEUED + 误回写
      const scheduledTaskId = this.queueScheduledTaskIds.get(sessionId);
      if (scheduledTaskId != null) {
        this.queueScheduledTaskIds.delete(sessionId);
        try {
          await this.deps.onScheduledTaskQueueConsumed?.(scheduledTaskId, 'CANCELLED');
        } catch (e) {
          console.warn(`Failed to write back scheduled task ${scheduledTaskId} after pre-exec cancel`, e);
        }
      }
      await this.finishCancelledSession(sessionId, userId, resolvedEventId ?? randomUUID());
      return;
    }
    this.cancelFlags.set(sessionId, flag);
    this.runningExecutionIds.set(sessionId, resolvedEventId);
    this.deps.registry.subscribe(userId, sessionId);
    this.submitExecution(sessionId, userId, resolvedEventId, (futureRef) =>
      this.runExecution(session, userId, sessionId, resolvedEventId, flag, clearTodos, futureRef), requeueIfClaimed);
  }

  /**
   * 提交 Agent 执行。线程池拒绝时必须回滚占位，否则该会话会被永久判定为
   * "already running"，后续所有发送都无法启动。
   */
  private submitExecution(
    sessionId: number,
    userId: number,
    executionId: string,
    run: (futureRef: { current: unknown }) => Promise<void>,
    requeueIfClaimed?: () => Promise<void>,
  ): void {
    const futureRef = { current: null as unknown };
    try {
      const future = this.deps.agentExecutor(() => run(futureRef));
      futureRef.current = future;
      this.runningTasks.set(sessionId, future);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Failed to submit agent execution for session ${sessionId}: ${message}`);
      this.executionClaims.delete(sessionId);
      this.autoConsumingSessionIds.delete(sessionId);
      this.runningExecutionIds.delete(sessionId);
      this.cancelFlags.delete(sessionId);
      this.deps.agentLoop.removeCancelFlag(sessionId);
      void requeueIfClaimed?.().catch((requeueErr) => {
        console.error(`Failed to re-enqueue auto-consumed message for session ${sessionId}`, requeueErr);
      });
      this.deps.registry.send(userId, wsEvent('error', sessionId, {
        message: '服务器繁忙，请稍后重试', executionId,
      }));
    }
  }

  private async runExecution(
    session: Session, userId: number, sessionId: number, executionId: string,
    cancelFlag: { get(): boolean; set(v: boolean): void }, clearTodos: boolean, futureRef: { current: unknown },
  ): Promise<void> {
    await this.withLock(this.sessionLocks, sessionId, async () => {
      // 终态驱动消费门禁：FAILED 时不再自动消费队列下一条。默认 'FAILED' 保守兜底——
      // 任何遗漏赋值的分支都倾向「不消费」，宁可暂停也不错误消耗用户消息。
      let terminalPhase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED';
      try {
        await this.deps.sessionService.updatePhase(sessionId, 'RUNNING');
        this.deps.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RUNNING', executionId }));
        this.deps.registry.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
        if (session.sessionType === 'SIDE_TASK') this.deps.treeSignalPublisher.publishIfSideTask(sessionId);
        const agent = session.agentId != null ? await this.deps.agentMapper.selectById(session.agentId) : null;
        if (session.executionMode === 'LOCAL' && agent) {
          const syncFailure = await this.syncSkillsToClient(userId, sessionId, session, agent);
          if (syncFailure) {
            const message = `技能同步失败：${syncFailure}`;
            terminalPhase = await this.finishFailedSession(sessionId, userId, executionId, message);
            this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId }));
            return;
          }
          await this.syncMcpServersToClient(userId, sessionId, session, agent);
        }
        if (session.executionMode === 'CLOUD' && agent) {
          try { await this.deps.skillSyncService.syncToSession(agent, userId, sessionId); } catch { /* ignore */ }
        }
        if (clearTodos) {
          await this.deps.sessionTodoMapper.deleteBySessionId(sessionId);
          this.deps.registry.send(userId, wsEvent('todo_updated', sessionId, { todos: [] }));
        }
        const listener = new WsStreamingEventListener(
          { registry: this.deps.registry, activityService: this.deps.activityService, activityHeartbeat: this.deps.activityHeartbeat, sessionTodoMapper: this.deps.sessionTodoMapper, sessionService: this.deps.sessionService },
          sessionId, userId, executionId, await this.resolveSupportsVision(session),
        );
        await this.deps.harnessService.executeFromEvent(sessionId, executionId, listener, cancelFlag);
        if (cancelFlag.get()) {
          await this.finishCancelledSession(sessionId, userId, executionId);
          terminalPhase = 'CANCELLED';
        } else {
          terminalPhase = await this.finishCompletedSession(sessionId, userId, executionId);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Agent 执行异常';
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId }));
        terminalPhase = await this.finishFailedSession(sessionId, userId, executionId, message);
      } finally {
        try {
          this.releaseSessionExecutionResources(sessionId);
        } catch (e) {
          console.warn(`Failed to release execution resources for session ${sessionId}`, e);
        }
        this.deps.registry.clearActiveToolCalls(sessionId);
        if (this.runningTasks.get(sessionId) === futureRef.current) this.runningTasks.delete(sessionId);
        if (this.runningExecutionIds.get(sessionId) === executionId) this.runningExecutionIds.delete(sessionId);
        this.executionClaims.delete(sessionId);
        this.cancelFlags.delete(sessionId);
        this.pendingCancels.delete(sessionId);
        this.deps.agentLoop.removeCancelFlag(sessionId);
        this.deps.activityHeartbeat.clear(sessionId);
        // busy 入队的定时任务：队列真正执行到终态后回写 lastExecutionStatus，避免永久停在 QUEUED
        const scheduledTaskId = this.queueScheduledTaskIds.get(sessionId);
        if (scheduledTaskId != null) {
          this.queueScheduledTaskIds.delete(sessionId);
          try {
            await this.deps.onScheduledTaskQueueConsumed?.(scheduledTaskId, terminalPhase);
          } catch (e) {
            console.warn(`Failed to write back scheduled task ${scheduledTaskId} after queue consume`, e);
          }
        }
        if (terminalPhase !== 'FAILED') await this.autoConsumeQueue(sessionId, userId);
      }
    });
  }

  /**
   * Run an already-persisted USER prompt on the live WS path (scheduled tasks).
   * Does not re-submit to the agent executor — caller must already be on that pool.
   */
  async executePersistedUserPrompt(
    session: Session,
    userId: number,
    executionId: string,
    savedMessage: Message,
  ): Promise<void> {
    const sessionId = session.id!;
    this.deps.titleService.scheduleForFirstUserMessage(sessionId, savedMessage.id, savedMessage.content ?? '');
    if (session.executionMode === 'LOCAL') {
      this.deps.localToolSessionRegistry.setUserForSession(sessionId, userId);
      if (!(await this.deps.localToolSessionRegistry.isConnected(sessionId))) {
        throw new Error('Local client is not connected. Please ensure the desktop app is running.');
      }
    }
    this.deps.registry.send(userId, wsEvent('user_message_saved', sessionId, {
      messageId: savedMessage.id,
      source: 'scheduled',
      content: typeof savedMessage.content === 'string' ? savedMessage.content : '',
      tempEventId: '',
    }));
    this.deps.registry.subscribe(userId, sessionId);
    const flag = this.deps.agentLoop.registerCancelFlag(sessionId);
    this.cancelFlags.set(sessionId, flag);
    this.runningExecutionIds.set(sessionId, executionId);
    if (!this.executionClaims.has(sessionId)) this.executionClaims.add(sessionId);
    const futureRef = { current: null as unknown };
    const run = this.runExecution(session, userId, sessionId, executionId, flag, false, futureRef);
    futureRef.current = run;
    this.runningTasks.set(sessionId, run);
    await run;
  }

  private async handleEditAndResend(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const messageId = this.getLong(root, 'messageId');
    if (sessionId == null || messageId == null) return;
    const content = typeof root.content === 'string' ? root.content : '';
    const images = Array.isArray(root.images) ? root.images.map(String) : [];
    const session = await this.requireOwnedSession(userId, sessionId);
    if (!session) return;
    if (this.isSessionActive(session.phase)) {
      this.sendSessionAlreadyRunning(userId, sessionId);
      return;
    }
    // 按 id 单调序定位最后一条用户消息：created_at 在跨节点时钟偏移下可能乱序，
    // 误判目标会导致 editMessageAndTruncate 逻辑删除大量无辜消息
    const lastUser = await this.deps.sessionService.getLastUserMessage(sessionId);
    if (!lastUser || lastUser.id !== messageId) {
      this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '只能编辑最后一条用户消息' }));
      return;
    }
    if (images.length > 0) {
      const model = await this.resolveSessionModel(session);
      if (!model || model.supportsVision !== 1) {
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '当前模型不支持图片输入，请切换支持视觉的模型' }));
        return;
      }
      if (images.length > 10) {
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '单条消息最多支持 10 张图片' }));
        return;
      }
    }
    if (this.executionClaims.has(sessionId)) {
      this.sendSessionAlreadyRunning(userId, sessionId);
      return;
    }
    this.executionClaims.add(sessionId);
    if (session.executionMode === 'LOCAL') {
      this.deps.localToolSessionRegistry.setUserForSession(sessionId, userId);
      if (!(await this.deps.localToolSessionRegistry.isConnected(sessionId))) {
        this.executionClaims.delete(sessionId);
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: 'Local client is not connected. Please ensure the desktop app is running.' }));
        return;
      }
      this.deps.localSkillRegistry.report(sessionId, this.parseLocalSkills(root.localSkills));
      this.deps.localAgentsMdRegistry.report(sessionId, typeof root.agentsMdContent === 'string' ? root.agentsMdContent : null);
    }
    try {
      await this.deps.sessionService.editMessageAndTruncate(sessionId, messageId, content, images);
    } catch (e) {
      this.executionClaims.delete(sessionId);
      this.deps.registry.send(userId, wsEvent('error', sessionId, { message: `编辑消息失败: ${e instanceof Error ? e.message : String(e)}` }));
      return;
    }
    const messageContent: unknown = images.length === 0 ? content : contentParts(content, images);
    try {
      const resolvedEventId = await this.deps.harnessService.prepareMessage(sessionId, messageContent);
      this.deps.registry.subscribe(userId, sessionId);
      const flag = this.deps.agentLoop.registerCancelFlag(sessionId);
      this.cancelFlags.set(sessionId, flag);
      this.runningExecutionIds.set(sessionId, resolvedEventId);
      this.submitExecution(sessionId, userId, resolvedEventId, (futureRef) =>
        this.runExecution(session, userId, sessionId, resolvedEventId, flag, true, futureRef));
    } catch (e) {
      // claim 添加后、执行提交前的异常路径必须释放占位，否则会话永久判定 busy。
      // submitExecution 提交被拒时已自行回滚并发事件，仅当占位仍在时才收敛，避免重复发 error。
      if (!this.executionClaims.has(sessionId)) return;
      this.cancelFlags.delete(sessionId);
      this.runningExecutionIds.delete(sessionId);
      this.deps.agentLoop.removeCancelFlag(sessionId);
      this.executionClaims.delete(sessionId);
      this.deps.registry.send(userId, wsEvent('error', sessionId, {
        message: `编辑重发失败: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  private async handleToolResult(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const requestId = typeof root.requestId === 'string' ? root.requestId : null;
    const result = typeof root.result === 'string' ? root.result : '{}';
    if (sessionId == null || requestId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    this.deps.localToolSessionRegistry.completeToolRequest(sessionId, requestId, result);
  }

  /** LOCAL 审批卡片点「执行/拒绝」后立即恢复 RUNNING，不必等命令真正跑完。 */
  private async handleToolApproval(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const requestId = typeof root.requestId === 'string' ? root.requestId : null;
    if (sessionId == null || requestId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    await Promise.resolve(this.deps.approvalRegistry.unregister(sessionId, requestId));
    await Promise.resolve(this.deps.treeSignalPublisher.publishForSession(sessionId));
  }

  private async handlePageToolResult(session: WsSocket, userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const requestId = typeof root.requestId === 'string' ? root.requestId : null;
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : null;
    if (sessionId == null || !requestId || !data || !(await this.requireOwnedSession(userId, sessionId))) return;
    // 只接受该会话绑定的页面连接回包；同用户其他标签页/其他客户端不能完成请求。
    if (!this.deps.registry.getEmbedSessionsForConnection(session).includes(sessionId)) return;
    const error = data.error != null && typeof data.error === 'object' ? data.error as Record<string, unknown> : null;
    this.deps.embedPageToolRegistry.complete(sessionId, requestId, session, {
      success: data.success === true,
      result: data.result,
      error: error == null ? undefined : {
        code: typeof error.code === 'string' ? error.code : 'page_tool_failed',
        message: typeof error.message === 'string' ? error.message : '页面操作失败',
        ...(typeof error.elementId === 'string' ? { elementId: error.elementId } : {}),
      },
      ...(typeof data.snapshotId === 'string' ? { snapshotId: data.snapshotId } : {}),
      ...(typeof data.pageVersion === 'string' ? { pageVersion: data.pageVersion } : {}),
    });
  }
  private async handleToolError(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const requestId = typeof root.requestId === 'string' ? root.requestId : null;
    const error = typeof root.error === 'string' ? root.error : 'Unknown error';
    if (sessionId == null || requestId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    this.deps.localToolSessionRegistry.completeToolRequestError(sessionId, requestId, error);
  }

  private async handleAskUserQuestionsResult(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const data = root.data as Record<string, unknown> | undefined;
    if (sessionId == null || !data) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const requestId = typeof data.requestId === 'string' ? data.requestId : null;
    if (!requestId) return;
    const answers = Array.isArray(data.answers) ? data.answers : [];
    const resultJson = JSON.stringify({ answers });
    const completed = this.deps.askUserQuestionsRegistry.complete(sessionId, requestId, resultJson);
    if (completed) {
      const executionId = this.runningExecutionIds.get(sessionId);
      this.deps.registry.send(userId, wsEvent('ask_user_questions_cancelled', sessionId, { requestId }));
      this.deps.registry.send(userId, wsEvent('session_status', sessionId, {
        phase: 'RUNNING',
        ...(executionId ? { executionId } : {}),
      }));
      this.deps.registry.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
      this.deps.treeSignalPublisher.publishForSession(sessionId);
    }
  }

  private async handleCreateSideSession(userId: number, root: Record<string, unknown>): Promise<void> {
    const parentSessionId = this.getLong(root, 'sessionId');
    if (parentSessionId == null) return;
    const data = (root.data ?? {}) as Record<string, unknown>;
    if (typeof data.content !== 'string') return;
    const content = data.content;
    const inheritContext = data.inheritContext === true;
    const modelId = data.modelId != null ? Number(data.modelId) : null;
    const images = Array.isArray(data.images) ? data.images.map(String) : [];
    if ((!content || content.trim() === '') && images.length === 0) return;
    const parentSession = await this.requireOwnedSession(userId, parentSessionId);
    if (!parentSession) return;
    this.deps.registry.subscribe(userId, parentSessionId);
    if (parentSession.executionMode === 'LOCAL' && !this.deps.registry.hasLocalClientConnection(userId)) {
      this.deps.registry.send(userId, wsEvent('error', parentSessionId, { message: 'Local client is not connected. Please ensure the desktop app is running.' }));
      return;
    }
    const resolvedModelId = modelId ?? parentSession.modelId ?? null;
    if (images.length > 0) {
      const probe: Session = { modelId: resolvedModelId ?? undefined, agentId: parentSession.agentId };
      const model = await this.resolveSessionModel(probe);
      if (!model || model.supportsVision !== 1) {
        this.deps.registry.send(userId, wsEvent('error', parentSessionId, { message: '当前模型不支持图片输入，请切换支持视觉的模型' }));
        return;
      }
      if (images.length > 10) {
        this.deps.registry.send(userId, wsEvent('error', parentSessionId, { message: '单条消息最多支持 10 张图片' }));
        return;
      }
    }
    const sideSession: Session = {
      userId, agentId: parentSession.agentId, executionMode: parentSession.executionMode,
      workspace: parentSession.workspace, projectKey: parentSession.projectKey, permissionLevel: parentSession.permissionLevel,
      modelId: resolvedModelId ?? undefined, isGit: parentSession.isGit, platform: parentSession.platform,
      shellPath: parentSession.shellPath, osVersion: parentSession.osVersion, status: 'ACTIVE',
      parentSessionId, sessionType: 'SIDE_TASK', title: '任务',
    };
    await this.deps.sessionService.save(sideSession);
    const sideSessionId = sideSession.id!;
    if (sideSession.executionMode === 'LOCAL') {
      this.deps.localToolSessionRegistry.setUserForSession(sideSessionId, userId);
      this.deps.localSkillRegistry.report(sideSessionId, this.parseLocalSkills(data.localSkills));
      this.deps.localAgentsMdRegistry.report(sideSessionId, typeof data.agentsMdContent === 'string' ? data.agentsMdContent : null);
    }
    const messageContent = images.length === 0 ? content : contentParts(content, images);
    const savedMessage = await this.deps.sessionService.saveMessage(sideSessionId, 'USER', messageContent, null, null, null, 0, null);
    const clientRequestId = typeof data.clientRequestId === 'string' ? data.clientRequestId : null;
    this.deps.registry.send(userId, wsEvent('side_session_created', parentSessionId, {
      sideSessionId, title: sideSession.title, ...(clientRequestId ? { clientRequestId } : {}),
    }));
    this.deps.titleService.scheduleForFirstUserMessage(sideSessionId, savedMessage.id, messageContent);
    this.deps.registry.send(userId, wsEvent('user_message_saved', sideSessionId, { messageId: savedMessage.id }));
    this.executionClaims.add(sideSessionId);
    const flag = this.deps.agentLoop.registerCancelFlag(sideSessionId);
    this.cancelFlags.set(sideSessionId, flag);
    const sideExecutionId = randomUUID();
    this.runningExecutionIds.set(sideSessionId, sideExecutionId);
    const futureRef = { current: null as unknown };
    try {
      const future = this.deps.agentExecutor(async () => {
      await this.withLock(this.sessionLocks, sideSessionId, async () => {
        let terminalPhase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED';
        try {
          await this.deps.sessionService.updateField(sideSessionId, 'phase', 'RUNNING');
          this.deps.registry.send(userId, wsEvent('session_status', sideSessionId, { phase: 'RUNNING', executionId: sideExecutionId }));
          this.deps.treeSignalPublisher.publishIfSideTask(sideSessionId);
          if (sideSession.executionMode === 'LOCAL' && sideSession.agentId != null) {
            const sideAgent = await this.deps.agentMapper.selectById(sideSession.agentId);
            if (sideAgent) {
              const syncFailure = await this.syncSkillsToClient(userId, sideSessionId, sideSession, sideAgent);
              if (syncFailure) {
                const message = `技能同步失败：${syncFailure}`;
                terminalPhase = await this.finishFailedSession(sideSessionId, userId, sideExecutionId, message);
                this.deps.registry.send(userId, wsEvent('error', sideSessionId, { message, executionId: sideExecutionId }));
                return;
              }
              await this.syncMcpServersToClient(userId, sideSessionId, sideSession, sideAgent);
            }
          }
          const listener = new WsStreamingEventListener(
            { registry: this.deps.registry, activityService: this.deps.activityService, activityHeartbeat: this.deps.activityHeartbeat, sessionTodoMapper: this.deps.sessionTodoMapper, sessionService: this.deps.sessionService },
            sideSessionId, userId, sideExecutionId, await this.resolveSupportsVision(sideSession),
          );
          await this.deps.harnessService.executeSideFirstMessage(parentSessionId, sideSessionId, inheritContext, listener, flag);
          if (flag.get()) {
            await this.deps.taskTerminalService.finishExecution(sideSessionId, userId, 'CANCELLED', sideExecutionId);
            terminalPhase = 'CANCELLED';
          } else {
            terminalPhase = await this.finishCompletedSession(sideSessionId, userId, sideExecutionId);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : '未知错误';
          terminalPhase = await this.finishFailedSession(sideSessionId, userId, sideExecutionId, message);
          this.deps.registry.send(userId, wsEvent('error', sideSessionId, { message }));
        } finally {
          try {
            this.releaseSessionExecutionResources(sideSessionId);
          } catch (e) {
            console.warn(`Failed to release execution resources for session ${sideSessionId}`, e);
          }
          this.deps.registry.clearActiveToolCalls(sideSessionId);
          if (this.runningTasks.get(sideSessionId) === futureRef.current) this.runningTasks.delete(sideSessionId);
          if (this.runningExecutionIds.get(sideSessionId) === sideExecutionId) this.runningExecutionIds.delete(sideSessionId);
          this.executionClaims.delete(sideSessionId);
          this.cancelFlags.delete(sideSessionId);
          this.deps.agentLoop.removeCancelFlag(sideSessionId);
          this.deps.activityHeartbeat.clear(sideSessionId);
          if (terminalPhase !== 'FAILED') await this.autoConsumeQueue(sideSessionId, userId);
        }
      });
    });
      futureRef.current = future;
      this.runningTasks.set(sideSessionId, future);
    } catch {
      this.executionClaims.delete(sideSessionId);
      this.cancelFlags.delete(sideSessionId);
      this.runningExecutionIds.delete(sideSessionId);
      this.deps.agentLoop.removeCancelFlag(sideSessionId);
      await this.finishFailedSession(sideSessionId, userId, sideExecutionId, '服务器繁忙，请稍后重试');
      this.deps.registry.send(userId, wsEvent('error', sideSessionId, { message: '服务器繁忙，请稍后重试' }));
      this.deps.registry.send(userId, wsEvent('error', parentSessionId, { message: '服务器繁忙，请稍后重试' }));
    }
  }

  private async handleCancelSideTask(userId: number, root: Record<string, unknown>): Promise<void> {
    const sideSessionId = this.getLong(root, 'sideSessionId');
    if (sideSessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sideSessionId))) return;
    const executionId = this.runningExecutionIds.get(sideSessionId) ?? '';
    this.abortRunningExecution(sideSessionId, userId);
    await this.finishCancelledSession(sideSessionId, userId, executionId);
  }

  /**
   * 处理用户点击「重试」按钮的请求。
   * 以宕机恢复语义重新执行：清理未完成尾巴消息 → 基于已有会话历史续跑，不插入新 user message。
   */
  private async handleRetryExecution(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    const session = await this.requireOwnedSession(userId, sessionId);
    if (!session) return;
    // 只有终态（FAILED）且没有正在运行的其他执行时才能重试
    if (!this.isTerminalPhase(session.phase)) {
      this.deps.registry.send(userId, wsEvent('error', sessionId, {
        message: '任务尚未结束，无法重试',
      }));
      return;
    }
    // 入口保证为终态（COMPLETED/FAILED/CANCELLED），供异常路径收敛回该状态。
    const entryPhase: string = session.phase!;
    if (this.executionClaims.has(sessionId)) {
      this.sendSessionAlreadyRunning(userId, sessionId);
      return;
    }
    this.executionClaims.add(sessionId);
    let phaseAdvanced = false;
    // beginRetry 成功后 execution 已置 RUNNING 并纳入跟踪；此后任何失败出口
    // （LOCAL 检查/提交前异常）都必须收敛回 FAILED，否则记录永久卡 RUNNING。
    let retryTaskId: number | null = null;
    try {
      // 后台子代理会话的重试：先在子代理管理器做开始簿记（execution 置回 RUNNING 并纳入
      // 运行跟踪），否则主代理 check_subagent/wait_subagents 感知不到这次重试执行。
      if (session.sessionType === 'SUBAGENT' && session.parentSessionId != null) {
        const manager = this.deps.backgroundSubagentManager;
        if (!manager?.beginRetry || !manager.completeRetry) {
          this.executionClaims.delete(sessionId);
          this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '子代理重试功能不可用' }));
          return;
        }
        const began = await manager.beginRetry(session.parentSessionId, sessionId);
        if (!began.ok) {
          this.executionClaims.delete(sessionId);
          this.deps.registry.send(userId, wsEvent('error', sessionId, { message: began.error ?? '无法重试该子代理' }));
          return;
        }
        retryTaskId = began.taskId ?? null;
      }
      // 防御性订阅，确保客户端能收到流式事件
      this.deps.registry.subscribe(userId, sessionId);
      // LOCAL 模式：注册会话到用户映射并检查桌面端连接
      if (session.executionMode === 'LOCAL') {
        this.deps.localToolSessionRegistry.setUserForSession(sessionId, userId);
        if (!(await this.deps.localToolSessionRegistry.isConnected(sessionId))) {
          this.executionClaims.delete(sessionId);
          await this.rollbackSubagentRetry(session, retryTaskId);
          this.deps.registry.send(userId, wsEvent('error', sessionId, {
            message: 'Local client is not connected. Please ensure the desktop app is running.',
          }));
          return;
        }
        // 注意：不重新同步 skills — 复用已有会话上下文（有意为之）
      }
      // 补齐缺失的 tool output（与 CrashRecoveryRunner 一致），避免重试再次 400
      const deleted = await this.deps.sessionService.cleanupIncompleteTail(sessionId);
      if (deleted > 0) {
        console.info(`Session ${sessionId}: filled ${deleted} missing tool output(s) before retry`);
      }
      // 置为 RESUMING 状态
      await this.deps.sessionService.updatePhase(sessionId, 'RESUMING');
      phaseAdvanced = true;
      this.deps.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RESUMING' }));
      // 分配新的 executionId
      const executionId = randomUUID();
      const cancelFlag = this.deps.agentLoop.registerCancelFlag(sessionId);
      this.cancelFlags.set(sessionId, cancelFlag);
      this.runningExecutionIds.set(sessionId, executionId);
      // 清除残留的 tool calls 和 ask questions 状态
      this.deps.registry.clearActiveToolCalls(sessionId);
      this.deps.askUserQuestionsRegistry.failAllForSession(sessionId);
      this.submitExecution(sessionId, userId, executionId, (futureRef) =>
        this.runRetryExecution(session, userId, sessionId, executionId, cancelFlag, futureRef, retryTaskId));
    } catch (e) {
      // claim 添加后、执行提交前的异常路径必须释放占位（同 M-4），否则会话永久判定 busy。
      // submitExecution 提交被拒时已自行回滚并发事件，这里仅在实际删除到 claim 时才补发 error，避免重复。
      if (phaseAdvanced) {
        // 置为 RESUMING 后、提交执行前异常：收敛回进入时的终态（入口已校验 isTerminalPhase），
        // 避免会话永久卡在 RESUMING。先恢复再释放 claim，缩小并发窗口。
        try {
          await this.deps.sessionService.updatePhase(sessionId, entryPhase);
        } catch { /* ignore */ }
      }
      this.cancelFlags.delete(sessionId);
      this.runningExecutionIds.delete(sessionId);
      this.deps.agentLoop.removeCancelFlag(sessionId);
      await this.rollbackSubagentRetry(session, retryTaskId);
      if (this.executionClaims.delete(sessionId)) {
        console.error(`Retry execution setup failed for session ${sessionId}`, e);
        this.deps.registry.send(userId, wsEvent('error', sessionId, {
          message: e instanceof Error ? e.message : '重试执行失败',
        }));
      }
    }
  }

  private async runRetryExecution(
    session: Session, userId: number, sessionId: number, executionId: string,
    cancelFlag: { get(): boolean; set(v: boolean): void }, futureRef: { current: unknown },
    retryTaskId: number | null,
  ): Promise<void> {
    await this.withLock(this.sessionLocks, sessionId, async () => {
      let terminalPhase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED';
      try {
        await this.deps.sessionService.updatePhase(sessionId, 'RUNNING');
        this.deps.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RUNNING', executionId }));
        this.deps.registry.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
        if (session.sessionType === 'SIDE_TASK') this.deps.treeSignalPublisher.publishIfSideTask(sessionId);
        // 不重新同步 skills/todos — 复用已有会话上下文
        const listener = new WsStreamingEventListener(
          { registry: this.deps.registry, activityService: this.deps.activityService, activityHeartbeat: this.deps.activityHeartbeat, sessionTodoMapper: this.deps.sessionTodoMapper, sessionService: this.deps.sessionService },
          sessionId, userId, executionId, await this.resolveSupportsVision(session),
        );
        await this.deps.harnessService.executeFromEvent(sessionId, executionId, listener, cancelFlag);
        if (cancelFlag.get()) {
          await this.finishCancelledSession(sessionId, userId, executionId);
          terminalPhase = 'CANCELLED';
        } else {
          terminalPhase = await this.finishCompletedSession(sessionId, userId, executionId);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Agent 重试执行异常';
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId }));
        terminalPhase = await this.finishFailedSession(sessionId, userId, executionId, message);
      } finally {
        try {
          this.releaseSessionExecutionResources(sessionId);
        } catch (e) {
          console.warn(`Failed to release execution resources for session ${sessionId}`, e);
        }
        this.deps.registry.clearActiveToolCalls(sessionId);
        if (this.runningTasks.get(sessionId) === futureRef.current) this.runningTasks.delete(sessionId);
        if (this.runningExecutionIds.get(sessionId) === executionId) this.runningExecutionIds.delete(sessionId);
        this.executionClaims.delete(sessionId);
        this.cancelFlags.delete(sessionId);
        this.pendingCancels.delete(sessionId);
        this.deps.agentLoop.removeCancelFlag(sessionId);
        this.deps.activityHeartbeat.clear(sessionId);
        if (retryTaskId != null && session.parentSessionId != null) {
          // 重试结束后收敛子代理 execution 记录并按需向主代理投递结果；
          // 簿记失败不影响会话终态（session.phase 已由 finishXxxSession 落库）。
          try {
            await this.deps.backgroundSubagentManager?.completeRetry?.(session.parentSessionId, retryTaskId, terminalPhase);
          } catch (e) {
            console.error(`Failed to finalize subagent retry for task ${retryTaskId}`, e);
          }
        }
        if (terminalPhase !== 'FAILED') await this.autoConsumeQueue(sessionId, userId);
      }
    });
  }

  /** beginRetry 成功但重试未能启动时的收敛：execution 置回 FAILED，释放运行跟踪。 */
  private async rollbackSubagentRetry(session: Session, retryTaskId: number | null): Promise<void> {
    if (retryTaskId == null || session.parentSessionId == null) return;
    try {
      await this.deps.backgroundSubagentManager?.completeRetry?.(session.parentSessionId, retryTaskId, 'FAILED');
    } catch (e) {
      console.error(`Failed to roll back subagent retry for task ${retryTaskId}`, e);
    }
  }

  private async handleCancel(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    // 用户点击停止：立刻取消该会话等待中的页面操作，不让工具挂到超时。
    this.deps.embedPageToolRegistry.failSession(sessionId, '用户已停止任务，页面操作已取消');
    if (!this.cancelFlags.has(sessionId)) {
      // 执行尚未提交（send 的模型校验/LOCAL 检查/saveMessage await 期间，或 autoConsume 的 500ms 延迟窗口）：
      // cancel flag 尚未注册，直接 set(true) 会空转。记录待取消标记（注册标志时按时间判定消费），
      // 同时落 CANCELLED 终态，保证 DB 状态收敛。
      // claim 已持有但 flag 未注册的窗口同样适用：否则 send 从 await 恢复后会照常提交执行，
      // 并把此处写入的 CANCELLED 覆盖回 RUNNING，用户的取消被静默丢弃。
      this.pendingCancels.set(sessionId, Date.now());
      this.deps.registry.send(userId, wsEvent('cancelled', sessionId, { pending: true, executionId: this.runningExecutionIds.get(sessionId) ?? '' }));
      await this.finishCancelledSession(sessionId, userId, this.runningExecutionIds.get(sessionId) ?? randomUUID());
      return;
    }
    const executionId = this.runningExecutionIds.get(sessionId) ?? '';
    this.abortRunningExecution(sessionId, userId);
    await this.finishCancelledSession(sessionId, userId, executionId);
  }

  private async handleEnqueueMessage(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const data = root.data as Record<string, unknown> | undefined;
    if (!data || typeof data.content !== 'string') return;
    const images = Array.isArray(data.images) && data.images.length > 0 ? JSON.stringify(data.images) : null;
    await this.deps.messageQueueService.enqueue(sessionId, userId, data.content, images);
    await this.sendQueueUpdated(sessionId, userId);
  }

  private async handleInsertMessage(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const data = root.data as Record<string, unknown> | undefined;
    if (!data || data.queueId == null) return;
    const queueId = Number(data.queueId);
    this.suppressAutoConsumeSend.add(sessionId);
    try {
      this.deps.agentExecutor(async () => {
        await this.withLock(this.insertLocks, sessionId, async () => {
        try {
          const item = await this.deps.messageQueueService.getById(queueId);
          // 仅允许插队仍处于 PENDING 的队列项：已消费/已删除（status=DELETED）不得再次执行
          if (!item || item.sessionId !== sessionId || item.status !== 'PENDING') {
            await this.sendQueueUpdated(sessionId, userId);
            return;
          }
          // 校验通过后才终止旧执行：对无效/已消费的队列消息不应误杀正在运行的任务
          this.abortRunningExecution(sessionId, userId);
          if (!(await this.awaitExecutionRelease(sessionId, 30_000))) {
            this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '旧任务取消超时，消息仍保留在队列中' }));
            return;
          }
          if (this.executionClaims.has(sessionId)) {
            this.sendSessionAlreadyRunning(userId, sessionId);
            return;
          }
          if (this.pendingCancels.delete(sessionId)) {
            // 窗口期内有过「停止」：不执行插队消息，保留在队列
            this.executionClaims.delete(sessionId);
            await this.sendQueueUpdated(sessionId, userId);
            return;
          }
          // abort 等待期间该项可能已被 autoConsume 消费：二次校验 status，避免重复执行
          {
            const latest = await this.deps.messageQueueService.getById(queueId);
            if (!latest || latest.status !== 'PENDING') {
              this.executionClaims.delete(sessionId);
              await this.sendQueueUpdated(sessionId, userId);
              return;
            }
          }
          this.executionClaims.add(sessionId);
          // 插队消费带来源的定时任务消息：与 autoConsume 对齐，绑定后由 runExecution finally 回写
          if (item.scheduledTaskId != null) {
            this.queueScheduledTaskIds.set(sessionId, item.scheduledTaskId);
          }
          const content = item.content ?? '';
          let imageList: string[] = [];
          if (item.images) {
            try { imageList = JSON.parse(item.images) as string[]; } catch { /* ignore */ }
          }
          const messageContent: unknown = imageList.length === 0 ? content : contentParts(content, imageList);
          const savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, null, null, null, 0, null);
          await this.deps.messageQueueService.delete(queueId);
          await this.sendQueueUpdated(sessionId, userId);
          this.deps.titleService.scheduleForFirstUserMessage(sessionId, savedMessage.id, messageContent);
          const consumed: Record<string, unknown> = { messageId: String(savedMessage.id), content };
          if (imageList.length > 0) consumed.images = imageList;
          this.deps.registry.send(userId, wsEvent('queue_message_consumed', sessionId, consumed));
          this.autoConsumingSessionIds.add(sessionId);
          this.suppressAutoConsumeSend.delete(sessionId);
          await this.handleSendMessage(userId, {
            sessionId,
            data: {
              content, eventId: randomUUID(), clearTodos: false, replaceExecution: true, executionClaimHeld: true,
              images: imageList, ...(savedMessage.id != null ? { autoSavedMessageId: savedMessage.id } : {}),
            },
          }, false);
        } catch {
          this.autoConsumingSessionIds.delete(sessionId);
          this.executionClaims.delete(sessionId);
          // saveMessage/handleSendMessage 异常：清定时任务映射，避免陈旧 taskId 被下次无关执行误回写
          this.queueScheduledTaskIds.delete(sessionId);
        } finally {
          this.suppressAutoConsumeSend.delete(sessionId);
        }
      });
      });
    } catch {
      this.suppressAutoConsumeSend.delete(sessionId);
      this.executionClaims.delete(sessionId);
      this.autoConsumingSessionIds.delete(sessionId);
      this.queueScheduledTaskIds.delete(sessionId);
    }
  }

  private async handleDeleteQueueMessage(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const data = root.data as Record<string, unknown> | undefined;
    if (!data || data.queueId == null) return;
    const queueId = Number(data.queueId);
    const item = await this.deps.messageQueueService.getById(queueId);
    if (!item || item.sessionId !== sessionId) return;
    await this.deps.messageQueueService.delete(queueId);
    await this.sendQueueUpdated(sessionId, userId);
  }

  private async handleReorderQueueMessage(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const data = root.data as Record<string, unknown> | undefined;
    if (!data || data.queueId == null || typeof data.direction !== 'string') return;
    const item = await this.deps.messageQueueService.getById(Number(data.queueId));
    if (!item || item.sessionId !== sessionId) return;
    try {
      await this.deps.messageQueueService.reorder(Number(data.queueId), data.direction);
    } finally {
      // 失败（如死锁重试耗尽）也推送一次队列刷新，保证前端状态与库内收敛；
      // 推送自身失败仅记日志，避免替换 reorder 的原始异常导致归因失真
      try {
        await this.sendQueueUpdated(sessionId, userId);
      } catch (e) {
        console.error(`Failed to push queue update after reorder for session ${sessionId}`, e);
      }
    }
  }

  private async sendQueueUpdated(sessionId: number, userId: number): Promise<void> {
    const queue = await this.deps.messageQueueService.listPending(sessionId);
    const queueData: Array<Record<string, unknown>> = [];
    for (const item of queue) {
      const map: Record<string, unknown> = {
        id: String(item.id), sessionId: String(item.sessionId), content: item.content,
        sortOrder: item.sortOrder, createdAt: item.createdAt != null ? String(item.createdAt) : null,
      };
      if (item.images) {
        try { map.images = JSON.parse(item.images); } catch { /* skip */ }
      }
      queueData.push(map);
    }
    this.deps.registry.send(userId, wsEvent('queue_updated', sessionId, { queue: queueData }));
  }

  async autoConsumeQueue(sessionId: number, userId: number): Promise<void> {
    try {
      const queue = await this.deps.messageQueueService.listPending(sessionId);
      if (queue.length === 0) return;
      if (this.suppressAutoConsumeSend.has(sessionId)) return;
      // 先查占用再出队：若会话仍被占用则原位保留队头，
      // 避免先 dequeue 再 enqueue 把队头消息搬到队尾破坏 FIFO
      if (this.executionClaims.has(sessionId) || this.runningTasks.has(sessionId)) {
        await this.sendQueueUpdated(sessionId, userId);
        return;
      }
      // 原子占位后再出队：占位与出队之间无 await，手动 send_message 无法插队。
      // 若不占位，出队与延迟执行之间可能被手动发送抢占，导致消息被消费却永不执行。
      // 占位时刻即 autoConsume 取消窗口起点：saveMessage/500ms 延迟内的取消都必须被识别。
      const autoConsumeStartedAt = Date.now();
      this.executionClaims.add(sessionId);
      const head = await this.deps.messageQueueService.dequeue(sessionId);
      if (!head) {
        this.executionClaims.delete(sessionId);
        return;
      }
      // 定时任务 busy 入队来源：执行终态后回写 lastExecutionStatus
      if (head.scheduledTaskId != null) {
        this.queueScheduledTaskIds.set(sessionId, head.scheduledTaskId);
      }
      await this.sendQueueUpdated(sessionId, userId);
      const content = head.content ?? '';
      let imageList: string[] = [];
      if (head.images) {
        try { imageList = JSON.parse(head.images) as string[]; } catch { /* ignore */ }
      }
      const messageContent: unknown = imageList.length === 0 ? content : contentParts(content, imageList);
      let savedMessage;
      try {
        savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, null, null, null, 0, null);
      } catch (e) {
        // M-3：队列行已出队（dequeue 已删除），saveMessage 失败必须回补队首，否则消息静默丢失。
        console.error(`Failed to save auto-consumed message for session ${sessionId}, re-enqueueing`, e);
        // 回补时透传来源任务 id，并清内存映射，避免绑定丢失与陈旧回写
        this.queueScheduledTaskIds.delete(sessionId);
        await this.deps.messageQueueService.enqueueHead(sessionId, userId, content, head.images ?? null, head.scheduledTaskId ?? null);
        this.executionClaims.delete(sessionId);
        this.autoConsumingSessionIds.delete(sessionId);
        await this.sendQueueUpdated(sessionId, userId);
        return;
      }
      this.deps.titleService.scheduleForFirstUserMessage(sessionId, savedMessage.id, messageContent);
      const consumed: Record<string, unknown> = { messageId: String(savedMessage.id), content };
      if (imageList.length > 0) consumed.images = imageList;
      this.deps.registry.send(userId, wsEvent('queue_message_consumed', sessionId, consumed));
      this.autoConsumingSessionIds.add(sessionId);
      try {
        this.deps.agentExecutor(async () => {
          await new Promise((r) => setTimeout(r, 500));
          await this.handleSendMessage(userId, {
            sessionId,
            data: {
              content, eventId: randomUUID(), images: imageList, executionClaimHeld: true,
              autoConsumeStartedAt,
              ...(savedMessage.id != null ? { autoSavedMessageId: savedMessage.id } : {}),
            },
          }, true);
        });
      } catch (submitErr) {
        // 提交被拒时释放占位并回补队列，避免消息已出队却永不执行
        this.executionClaims.delete(sessionId);
        this.autoConsumingSessionIds.delete(sessionId);
        this.queueScheduledTaskIds.delete(sessionId);
        await this.deps.messageQueueService.enqueueHead(sessionId, userId, content, head.images ?? null, head.scheduledTaskId ?? null);
        throw submitErr;
      }
    } catch (e) {
      console.error(`Failed to auto-consume queue for session ${sessionId}`, e);
      this.executionClaims.delete(sessionId);
      this.autoConsumingSessionIds.delete(sessionId);
      // 映射已设置但后续异常（如 sendQueueUpdated 抛出）时清掉，避免陈旧 taskId 被下次无关执行误回写
      this.queueScheduledTaskIds.delete(sessionId);
    }
  }

  private async handleSkillSyncDone(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const success = root.success !== false;
    const error = typeof root.error === 'string' ? root.error : null;
    const reportSyncId = typeof root.syncId === 'string' ? root.syncId : null;
    console.info(`Received skill_sync_done from userId=${userId}, sessionId=${sessionId}, success=${success}, syncId=${reportSyncId ?? ''}`);
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const pending = this.pendingSkillSyncs.get(sessionId);
    // L-8：按 syncId 匹配轮次——迟到的旧轮次信号不得放行新一轮技能同步（MCP 侧已用 syncId，技能侧对齐）
    if (pending && reportSyncId != null && reportSyncId === pending.syncId) {
      if (success) pending.resolve();
      else pending.reject(new Error(error && error.trim() !== '' ? error : 'Skill sync failed on client'));
    } else if (pending && reportSyncId == null) {
      // 无法判定属于哪一轮同步，但客户端确实回过信号：立即以真实原因结束本轮，
      // 否则会空等到 60s 超时并报出误导性的「超时」（真实原因是客户端版本过旧）。
      pending.reject(new Error('客户端未回带技能同步标识 syncId，请升级桌面端或 mao-agent 后重试'));
    } else {
      console.warn(`No pending skill sync for session=${sessionId}`);
    }
  }

  private async handleMcpToolsReport(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const pending = this.pendingMcpSyncs.get(sessionId);
    const reportSyncId = typeof root.syncId === 'string' ? root.syncId : null;
    if (!pending) return;
    if (reportSyncId == null || reportSyncId !== pending.syncId) return;
    const tools: McpToolRef[] = [];
    const servers = root.servers;
    if (Array.isArray(servers)) {
      for (const serverNode of servers as Array<Record<string, unknown>>) {
        const connected = serverNode.connected !== false;
        const name = typeof serverNode.name === 'string' ? serverNode.name : null;
        if (!connected || !name) continue;
        const serverId = this.deps.mcpSyncService.resolveServerIdByName(name);
        const toolArray = serverNode.tools;
        if (!Array.isArray(toolArray)) continue;
        for (const toolNode of toolArray as Array<Record<string, unknown>>) {
          const toolName = typeof toolNode.name === 'string' ? toolNode.name : null;
          if (!toolName) continue;
          tools.push({
            serverId: serverId ?? 0,
            serverName: name,
            toolName,
            description: typeof toolNode.description === 'string' ? toolNode.description : '',
            inputSchema: (toolNode.schema as Record<string, unknown> | undefined)
              ?? (toolNode.inputSchema as Record<string, unknown> | undefined)
              ?? {},
          });
        }
      }
    }
    this.deps.mcpSyncService.recordReport(sessionId, tools);
    const current = this.pendingMcpSyncs.get(sessionId);
    if (current && current.syncId === reportSyncId) current.resolve();
  }

  /** 成功返回 null；失败返回具体原因（同时用于终态失败原因与前端 error 文案）。 */
  private async syncSkillsToClient(userId: number, sessionId: number, session: Session, agent: Agent): Promise<string | null> {
    if (!this.deps.registry.hasLocalClientConnection(userId)) {
      console.warn(`Skip skill sync for session ${sessionId}: no local client connected`);
      return '没有可执行本机工具的客户端连接（桌面端 / mao-agent 未连接）';
    }
    const syncUrl = `/v1/skills/sync-package?sessionId=${sessionId}`;
    const removed = this.deps.skillSyncService.getRemovedSkillNames(agent, userId, sessionId);
    console.info(`Syncing skills to client for session=${sessionId}, userId=${userId}, syncUrl=${syncUrl}, workspace=${session.workspace ?? ''}, removed=${JSON.stringify(removed)}`);
    const syncId = randomUUID();
    const done = new Promise<void>((resolve, reject) => {
      this.pendingSkillSyncs.set(sessionId, { syncId, resolve, reject });
    });
    this.deps.registry.sendToLocalClients(userId, wsEvent('skill_sync_required', sessionId, {
      syncUrl, removed, workspace: session.workspace ?? '', syncId,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('客户端 60 秒内未回报技能同步结果')), 60_000);
        }),
      ]);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Skill sync failed for session ${sessionId}: ${message}`);
      return message;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingSkillSyncs.delete(sessionId);
    }
  }

  private async syncMcpServersToClient(userId: number, sessionId: number, _session: Session, agent: Agent): Promise<void> {
    try {
      const servers = await this.deps.mcpSyncService.loadAgentServers(agent, userId);
      if (servers.length === 0) {
        this.deps.mcpSyncService.clearSession(sessionId);
        return;
      }
      if (!this.deps.registry.hasLocalClientConnection(userId)) {
        this.deps.mcpSyncService.clearSession(sessionId);
        return;
      }
      const payload = this.deps.mcpSyncService.buildSyncPayload(servers);
      const syncId = randomUUID();
      payload.syncId = syncId;
      const done = new Promise<void>((resolve, reject) => {
        this.pendingMcpSyncs.set(sessionId, { syncId, resolve, reject });
      });
      this.deps.registry.sendToLocalClients(userId, wsEvent('mcp_sync_required', sessionId, payload));
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), this.mcpSyncTimeoutSeconds * 1000)),
      ]);
    } catch {
      this.deps.mcpSyncService.clearSession(sessionId);
    } finally {
      this.pendingMcpSyncs.delete(sessionId);
    }
  }

  private releaseSessionExecutionResources(sessionId: number): void {
    this.deps.shellSessionManager.closeByConversation(sessionId);
    this.deps.localToolSessionRegistry.failAllForSession(sessionId);
    this.deps.askUserQuestionsRegistry.failAllForSession(sessionId);
    this.deps.localSkillRegistry.clear(sessionId);
    this.deps.localAgentsMdRegistry.clear(sessionId);
    this.deps.mcpSyncService.clearSession(sessionId);
    this.deps.mcpClientManager.closeSession(sessionId);
  }

  private abortRunningExecution(sessionId: number, userId: number, aggressive = false): void {
    this.cancelFlags.get(sessionId)?.set(true);
    this.deps.agentLoop.requestCancel(sessionId);
    this.deps.shellSessionManager.closeByConversation(sessionId);
    this.deps.localToolSessionRegistry.failAllForSession(sessionId);
    const skillSync = this.pendingSkillSyncs.get(sessionId);
    if (skillSync) skillSync.reject(new Error('会话已被取消'));
    const mcpSync = this.pendingMcpSyncs.get(sessionId);
    if (mcpSync) mcpSync.reject(new Error('会话已被取消'));
    void aggressive;
    this.deps.askUserQuestionsRegistry.failAllForSession(sessionId);
    void this.abortSubagentChildren(sessionId);
    void userId;
  }

  private async abortSubagentChildren(parentSessionId: number): Promise<void> {
    try {
      await this.deps.backgroundSubagentManager?.cancelAllForParent(parentSessionId);
      const children = await this.deps.sessionService.listSubagentSessions(parentSessionId);
      for (const child of children) {
        if (child.id == null) continue;
        this.cancelFlags.get(child.id)?.set(true);
        this.deps.agentLoop.requestCancel(child.id);
        this.deps.shellSessionManager.closeByConversation(child.id);
        this.deps.localToolSessionRegistry.failAllForSession(child.id);
        this.deps.askUserQuestionsRegistry.failAllForSession(child.id);
      }
    } catch { /* ignore */ }
  }

  private isSessionActive(phase: string | null | undefined): boolean {
    return isActivePhase(phase);
  }

  private isTerminalPhase(phase: string | null | undefined): boolean {
    return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
  }

  private sendSessionAlreadyRunning(userId: number, sessionId: number): void {
    const data: Record<string, unknown> = { code: 'session_already_running', message: '该任务仍在运行，请先停止当前执行后再继续' };
    const executionId = this.runningExecutionIds.get(sessionId);
    if (executionId) data.executionId = executionId;
    this.deps.registry.send(userId, wsEvent('session_already_running', sessionId, data));
  }

  private async awaitExecutionRelease(sessionId: number, timeoutMillis: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMillis;
    while ((this.executionClaims.has(sessionId) || this.runningTasks.has(sessionId)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !this.executionClaims.has(sessionId) && !this.runningTasks.has(sessionId);
  }

  /**
   * 收尾任务为 COMPLETED；返回实际生效的终态：
   * 会话已被并发取消（phase=CANCELLED）时返回 'CANCELLED'，供调用方（finally 消费门禁）准确判定。
   */
  private async finishCompletedSession(sessionId: number, userId: number, executionId: string): Promise<'COMPLETED' | 'CANCELLED'> {
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session?.phase === 'CANCELLED') return 'CANCELLED';
    await this.deps.taskTerminalService.finishExecution(sessionId, userId, 'COMPLETED', executionId);
    return 'COMPLETED';
  }

  /**
   * 收尾任务为 FAILED；返回实际生效的终态：
   * 会话已被并发取消（phase=CANCELLED）时返回 'CANCELLED'（此时队列消费不受阻）。
   */
  private async finishFailedSession(sessionId: number, userId: number, executionId: string, reason: string): Promise<'FAILED' | 'CANCELLED'> {
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session?.phase === 'CANCELLED') return 'CANCELLED';
    await this.deps.taskTerminalService.finishExecution(sessionId, userId, 'FAILED', executionId, reason);
    return 'FAILED';
  }

  private async finishCancelledSession(sessionId: number, userId: number, executionId: string): Promise<'CANCELLED'> {
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session && this.isTerminalPhase(session.phase)) return 'CANCELLED';
    await this.deps.sessionService.cleanupIncompleteTail(sessionId);
    await this.deps.taskTerminalService.finishExecution(sessionId, userId, 'CANCELLED', executionId);
    return 'CANCELLED';
  }

  private async resolveSessionModel(session: Session): Promise<LlmModel | null> {
    if (session.modelId != null) return this.deps.llmModelMapper.selectById(session.modelId);
    return this.deps.llmModelMapper.selectDefault();
  }

  private async resolveSupportsVision(session: Session): Promise<boolean> {
    const model = await this.resolveSessionModel(session);
    return model != null && model.supportsVision === 1;
  }

  private getLong(root: Record<string, unknown>, field: string): number | null {
    const v = root[field];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private parseLocalSkills(node: unknown): LocalSkillRef[] {
    if (!Array.isArray(node)) return [];
    const result: LocalSkillRef[] = [];
    for (const item of node as Array<Record<string, unknown>>) {
      if (!item || typeof item.name !== 'string' || typeof item.folderName !== 'string') continue;
      result.push({ name: item.name, folderName: item.folderName, description: typeof item.description === 'string' ? item.description : '' });
    }
    return result;
  }

  private async requireOwnedSession(userId: number, sessionId: number): Promise<Session | null> {
    let session: Session | null;
    try {
      session = await this.deps.sessionService.getSession(sessionId);
    } catch {
      this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '会话不存在' }));
      return null;
    }
    if (!session || session.userId !== userId) {
      this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '无权操作该会话' }));
      return null;
    }
    return session;
  }

  private handleAuthRefresh(session: WsSocket, root: Record<string, unknown>): void {
    const { requestId, token } = root;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256
      || typeof token !== 'string' || !token) {
      this.deps.registry.closeConnection(session, 'Invalid auth refresh');
      return;
    }
    const previous = this.deps.registry.getRefreshResult(session, requestId);
    if (previous !== undefined) {
      this.deps.registry.sendToConnection(session, { type: 'auth_refreshed', requestId, expiresAt: previous });
      return;
    }
    const metadata = this.deps.jwtService.getAccessTokenMetadata(token);
    if (!metadata || this.deps.jwtService.getTokenType(token) !== 'access'
      || !this.deps.registry.refreshAuthentication(session, requestId, metadata)) {
      this.deps.registry.closeConnection(session, 'Invalid auth refresh');
      return;
    }
    this.deps.registry.sendToConnection(session, { type: 'auth_refreshed', requestId, expiresAt: metadata.expiresAt });
  }

  private normalizeClient(client: string | undefined): string {
    if (client?.toLowerCase() === 'electron') return 'electron';
    if (client?.toLowerCase() === 'android') return 'android';
    if (client?.toLowerCase() === 'cli') return 'cli';
    if (client?.toLowerCase() === 'embed') return 'embed';
    return 'browser';
  }

  private async withLock(map: Map<number, Promise<void>>, id: number, fn: () => Promise<void>): Promise<void> {
    const prev = map.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => { release = r; });
    map.set(id, prev.then(() => current));
    await prev;
    try {
      await fn();
    } finally {
      release();
    }
  }
}

void cancelFlag;
