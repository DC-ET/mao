import { randomUUID } from 'node:crypto';
import type { Agent, ContentPart, LlmModel, LocalSkillRef, Message, MessageQueueItem, McpToolRef, Session } from '../../domain/types.js';
import type { JwtService } from '../../crypto/jwt.service.js';
import { contentParts, WsStreamingEventListener, type AgentEventListener, type WsListenerDeps } from './ws-streaming-event-listener.js';
import type { StreamingWsRegistry, WsSocket } from './streaming-ws-registry.js';
import { wsEvent } from './ws-event.js';
import { isActivePhase } from '../session-vo.js';

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
    enqueue(sessionId: number, userId: number, content: string, images: string | null): Promise<void>;
    enqueueHead(sessionId: number, userId: number, content: string, images: string | null): Promise<void>;
    dequeue(sessionId: number): Promise<MessageQueueItem | null>;
    getById(id: number): Promise<MessageQueueItem | null>;
    delete(id: number): Promise<void>;
    reorder(id: number, direction: string): Promise<void>;
  };
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
  private readonly pendingSkillSyncs = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly pendingMcpSyncs = new Map<number, { syncId: string; resolve: () => void; reject: (e: Error) => void }>();
  private readonly autoConsumingSessionIds = new Set<number>();
  private readonly suppressAutoConsumeSend = new Set<number>();
  private readonly insertLocks = new Map<number, Promise<void>>();
  private readonly mcpSyncTimeoutSeconds: number;

  constructor(private readonly deps: WsHandlerDeps) {
    this.mcpSyncTimeoutSeconds = deps.mcpSyncTimeoutSeconds ?? 60;
  }

  hasExecutionClaim(sessionId: number): boolean {
    return this.executionClaims.has(sessionId) || this.runningTasks.has(sessionId);
  }

  async afterConnectionEstablished(session: WsSocket, query: Record<string, string>): Promise<void> {
    const userId = this.parseUserIdFromToken(query.token);
    if (userId == null) {
      session.close(1003, 'Missing or invalid token');
      return;
    }
    const clientType = this.normalizeClient(query.client);
    this.deps.registry.register(session, userId, clientType);
    this.deps.registry.send(userId, wsEvent('connected', null, { userId }));
  }

  afterConnectionClosed(session: WsSocket): void {
    const userId = this.deps.registry.getUserId(session);
    this.deps.registry.unregister(session);
    if (userId != null && !this.deps.registry.hasLocalClientConnection(userId)) {
      this.deps.localToolSessionRegistry.failAllForUser(userId);
    }
  }

  handleTransportError(session: WsSocket): void {
    this.afterConnectionClosed(session);
  }

  async handleTextMessage(session: WsSocket, payload: string): Promise<void> {
    const userId = this.deps.registry.getUserId(session);
    if (userId == null) return;
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof root.type === 'string' ? root.type : null;
    if (!type) return;
    try {
      await this.dispatch(userId, type, root);
    } catch (e) {
      console.error(`WS handler failed for type=${type} userId=${userId}`, e);
    }
  }

  private async dispatch(userId: number, type: string, root: Record<string, unknown>): Promise<void> {
    switch (type) {
      case 'subscribe': await this.handleSubscribe(userId, root); break;
      case 'unsubscribe': this.handleUnsubscribe(userId, root); break;
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
      case 'tool_approval': await this.handleToolApproval(userId, root); break;
      case 'ask_user_questions_result': await this.handleAskUserQuestionsResult(userId, root); break;
      case 'create_side_session': await this.handleCreateSideSession(userId, root); break;
      case 'cancel_side_task': await this.handleCancelSideTask(userId, root); break;
      case 'retry_execution': await this.handleRetryExecution(userId, root); break;
      case 'ping': this.deps.registry.send(userId, wsEvent('pong', null, {})); break;
      default: break;
    }
  }

  private async handleSubscribe(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    const s = await this.requireOwnedSession(userId, sessionId);
    if (!s) return;
    this.deps.registry.subscribe(userId, sessionId);
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

  private handleUnsubscribe(userId: number, root: Record<string, unknown>): void {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    this.deps.registry.unsubscribe(userId, sessionId);
  }

  private async handleSendMessage(userId: number, root: Record<string, unknown>, clearTodos: boolean): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    const data = (root.data ?? {}) as Record<string, unknown>;
    // claimAlreadyHeld=true 表示调用方（auto-consume）已在出队前占位会话，
    // 本方法内任何未进入执行的失败出口都必须释放占位，否则会话永久卡死
    const claimAlreadyHeld = data.executionClaimHeld === true;
    if (typeof data.content !== 'string') {
      if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
      return;
    }
    const content = data.content;
    const eventId = typeof data.eventId === 'string' ? data.eventId : null;
    const images = Array.isArray(data.images) ? data.images.map(String) : [];
    const session = await this.requireOwnedSession(userId, sessionId);
    if (!session) {
      if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
      return;
    }
    const replacingExecution = data.replaceExecution === true;
    const isAutoConsume = this.autoConsumingSessionIds.delete(sessionId);
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
        if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '当前模型不支持图片输入，请切换支持视觉的模型' }));
        return;
      }
      if (images.length > 10) {
        if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
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
        this.executionClaims.delete(sessionId);
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message: 'Local client is not connected. Please ensure the desktop app is running.' }));
        return;
      }
      this.deps.localSkillRegistry.report(sessionId, this.parseLocalSkills(data.localSkills));
      this.deps.localAgentsMdRegistry.report(sessionId, typeof data.agentsMdContent === 'string' ? data.agentsMdContent : null);
    }
    const messageContent: unknown = images.length === 0 ? content : contentParts(content, images);
    if (!isAutoConsume) {
      const savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, null, null, null, 0, null);
      this.deps.titleService.scheduleForFirstUserMessage(sessionId, savedMessage.id, messageContent);
      this.deps.registry.send(userId, wsEvent('user_message_saved', sessionId, { tempEventId: eventId ?? '', messageId: savedMessage.id }));
    }
    const resolvedEventId = eventId && eventId.trim() !== '' ? eventId : await this.deps.harnessService.prepareMessage(sessionId, messageContent);
    this.deps.registry.subscribe(userId, sessionId);
    const flag = this.deps.agentLoop.registerCancelFlag(sessionId);
    this.cancelFlags.set(sessionId, flag);
    this.runningExecutionIds.set(sessionId, resolvedEventId);
    this.submitExecution(sessionId, userId, resolvedEventId, (futureRef) =>
      this.runExecution(session, userId, sessionId, resolvedEventId, flag, clearTodos, futureRef));
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
      try {
        await this.deps.sessionService.updatePhase(sessionId, 'RUNNING');
        this.deps.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RUNNING', executionId }));
        this.deps.registry.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
        if (session.sessionType === 'SIDE_TASK') this.deps.treeSignalPublisher.publishIfSideTask(sessionId);
        const agent = session.agentId != null ? await this.deps.agentMapper.selectById(session.agentId) : null;
        if (session.executionMode === 'LOCAL' && agent) {
          const synced = await this.syncSkillsToClient(userId, sessionId, session, agent);
          if (!synced) {
            await this.finishFailedSession(sessionId, userId, executionId, 'Skill sync failed or timed out');
            this.deps.registry.send(userId, wsEvent('error', sessionId, { message: 'Skill sync failed or timed out' }));
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
        if (cancelFlag.get()) await this.finishCancelledSession(sessionId, userId, executionId);
        else await this.finishCompletedSession(sessionId, userId, executionId);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Agent 执行异常';
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId }));
        await this.finishFailedSession(sessionId, userId, executionId, message);
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
        this.deps.agentLoop.removeCancelFlag(sessionId);
        this.deps.activityHeartbeat.clear(sessionId);
        await this.autoConsumeQueue(sessionId, userId);
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
    const resolvedEventId = await this.deps.harnessService.prepareMessage(sessionId, messageContent);
    this.deps.registry.subscribe(userId, sessionId);
    const flag = this.deps.agentLoop.registerCancelFlag(sessionId);
    this.cancelFlags.set(sessionId, flag);
    this.runningExecutionIds.set(sessionId, resolvedEventId);
    this.submitExecution(sessionId, userId, resolvedEventId, (futureRef) =>
      this.runExecution(session, userId, sessionId, resolvedEventId, flag, true, futureRef));
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
    const answersJson = data.answers != null ? JSON.stringify(data.answers) : '[]';
    const resultJson = `{"answers": ${answersJson}}`;
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
        try {
          await this.deps.sessionService.updateField(sideSessionId, 'phase', 'RUNNING');
          this.deps.registry.send(userId, wsEvent('session_status', sideSessionId, { phase: 'RUNNING', executionId: sideExecutionId }));
          this.deps.treeSignalPublisher.publishIfSideTask(sideSessionId);
          if (sideSession.executionMode === 'LOCAL' && sideSession.agentId != null) {
            const sideAgent = await this.deps.agentMapper.selectById(sideSession.agentId);
            if (sideAgent) {
              const synced = await this.syncSkillsToClient(userId, sideSessionId, sideSession, sideAgent);
              if (!synced) {
                await this.finishFailedSession(sideSessionId, userId, sideExecutionId, 'Skill sync failed or timed out');
                this.deps.registry.send(userId, wsEvent('error', sideSessionId, { message: 'Skill sync failed or timed out' }));
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
          if (flag.get()) await this.deps.taskTerminalService.finishExecution(sideSessionId, userId, 'CANCELLED', sideExecutionId);
          else await this.finishCompletedSession(sideSessionId, userId, sideExecutionId);
        } catch (e) {
          const message = e instanceof Error ? e.message : '未知错误';
          await this.finishFailedSession(sideSessionId, userId, sideExecutionId, message);
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
          await this.autoConsumeQueue(sideSessionId, userId);
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
    if (this.executionClaims.has(sessionId)) {
      this.sendSessionAlreadyRunning(userId, sessionId);
      return;
    }
    this.executionClaims.add(sessionId);
    // 防御性订阅，确保客户端能收到流式事件
    this.deps.registry.subscribe(userId, sessionId);
    // LOCAL 模式：注册会话到用户映射并检查桌面端连接
    if (session.executionMode === 'LOCAL') {
      this.deps.localToolSessionRegistry.setUserForSession(sessionId, userId);
      if (!(await this.deps.localToolSessionRegistry.isConnected(sessionId))) {
        this.executionClaims.delete(sessionId);
        this.deps.registry.send(userId, wsEvent('error', sessionId, {
          message: 'Local client is not connected. Please ensure the desktop app is running.',
        }));
        return;
      }
      // 注意：不重新同步 skills — 复用已有会话上下文（有意为之）
    }
    // 清理未完成尾巴消息（与 CrashRecoveryRunner 一致）
    const deleted = await this.deps.sessionService.cleanupIncompleteTail(sessionId);
    if (deleted > 0) {
      console.info(`Session ${sessionId}: cleaned up ${deleted} incomplete tail messages before retry`);
    }
    // 置为 RESUMING 状态
    await this.deps.sessionService.updatePhase(sessionId, 'RESUMING');
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
      this.runRetryExecution(session, userId, sessionId, executionId, cancelFlag, futureRef));
  }

  private async runRetryExecution(
    session: Session, userId: number, sessionId: number, executionId: string,
    cancelFlag: { get(): boolean; set(v: boolean): void }, futureRef: { current: unknown },
  ): Promise<void> {
    await this.withLock(this.sessionLocks, sessionId, async () => {
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
        if (cancelFlag.get()) await this.finishCancelledSession(sessionId, userId, executionId);
        else await this.finishCompletedSession(sessionId, userId, executionId);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Agent 重试执行异常';
        this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId }));
        await this.finishFailedSession(sessionId, userId, executionId, message);
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
        this.deps.agentLoop.removeCancelFlag(sessionId);
        this.deps.activityHeartbeat.clear(sessionId);
        await this.autoConsumeQueue(sessionId, userId);
      }
    });
  }

  private async handleCancel(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
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
    this.abortRunningExecution(sessionId, userId);
    try {
      this.deps.agentExecutor(async () => {
        await this.withLock(this.insertLocks, sessionId, async () => {
        try {
          const item = await this.deps.messageQueueService.getById(queueId);
          if (!item || item.sessionId !== sessionId) {
            await this.sendQueueUpdated(sessionId, userId);
            return;
          }
          if (!(await this.awaitExecutionRelease(sessionId, 30_000))) {
            this.deps.registry.send(userId, wsEvent('error', sessionId, { message: '旧任务取消超时，消息仍保留在队列中' }));
            return;
          }
          if (this.executionClaims.has(sessionId)) {
            this.sendSessionAlreadyRunning(userId, sessionId);
            return;
          }
          this.executionClaims.add(sessionId);
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
            data: { content, eventId: randomUUID(), clearTodos: false, replaceExecution: true, executionClaimHeld: true, images: imageList },
          }, false);
        } catch {
          this.autoConsumingSessionIds.delete(sessionId);
          this.executionClaims.delete(sessionId);
        } finally {
          this.suppressAutoConsumeSend.delete(sessionId);
        }
      });
      });
    } catch {
      this.suppressAutoConsumeSend.delete(sessionId);
      this.executionClaims.delete(sessionId);
      this.autoConsumingSessionIds.delete(sessionId);
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
    await this.deps.messageQueueService.reorder(Number(data.queueId), data.direction);
    await this.sendQueueUpdated(sessionId, userId);
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
      this.executionClaims.add(sessionId);
      const head = await this.deps.messageQueueService.dequeue(sessionId);
      if (!head) {
        this.executionClaims.delete(sessionId);
        return;
      }
      await this.sendQueueUpdated(sessionId, userId);
      const content = head.content ?? '';
      let imageList: string[] = [];
      if (head.images) {
        try { imageList = JSON.parse(head.images) as string[]; } catch { /* ignore */ }
      }
      const messageContent: unknown = imageList.length === 0 ? content : contentParts(content, imageList);
      const savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, null, null, null, 0, null);
      this.deps.titleService.scheduleForFirstUserMessage(sessionId, savedMessage.id, messageContent);
      const consumed: Record<string, unknown> = { messageId: String(savedMessage.id), content };
      if (imageList.length > 0) consumed.images = imageList;
      this.deps.registry.send(userId, wsEvent('queue_message_consumed', sessionId, consumed));
      this.autoConsumingSessionIds.add(sessionId);
      try {
        this.deps.agentExecutor(async () => {
          await new Promise((r) => setTimeout(r, 500));
          await this.handleSendMessage(userId, { sessionId, data: { content, eventId: randomUUID(), images: imageList, executionClaimHeld: true } }, true);
        });
      } catch (submitErr) {
        // 提交被拒时释放占位并回补队列，避免消息已出队却永不执行
        this.executionClaims.delete(sessionId);
        this.autoConsumingSessionIds.delete(sessionId);
        await this.deps.messageQueueService.enqueueHead(sessionId, userId, content, head.images ?? null);
        throw submitErr;
      }
    } catch (e) {
      console.error(`Failed to auto-consume queue for session ${sessionId}`, e);
      this.executionClaims.delete(sessionId);
      this.autoConsumingSessionIds.delete(sessionId);
    }
  }

  private async handleSkillSyncDone(userId: number, root: Record<string, unknown>): Promise<void> {
    const sessionId = this.getLong(root, 'sessionId');
    const success = root.success !== false;
    const error = typeof root.error === 'string' ? root.error : null;
    console.info(`Received skill_sync_done from userId=${userId}, sessionId=${sessionId}, success=${success}`);
    if (sessionId == null) return;
    if (!(await this.requireOwnedSession(userId, sessionId))) return;
    const pending = this.pendingSkillSyncs.get(sessionId);
    if (pending) {
      if (success) pending.resolve();
      else pending.reject(new Error(error && error.trim() !== '' ? error : 'Skill sync failed on client'));
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

  private async syncSkillsToClient(userId: number, sessionId: number, session: Session, agent: Agent): Promise<boolean> {
    if (!this.deps.registry.hasLocalClientConnection(userId)) {
      console.warn(`Skip skill sync for session ${sessionId}: no Electron client connected`);
      return false;
    }
    const syncUrl = `/v1/skills/sync-package?sessionId=${sessionId}`;
    const removed = this.deps.skillSyncService.getRemovedSkillNames(agent, userId, sessionId);
    console.info(`Syncing skills to client for session=${sessionId}, userId=${userId}, syncUrl=${syncUrl}, workspace=${session.workspace ?? ''}, removed=${JSON.stringify(removed)}`);
    const done = new Promise<void>((resolve, reject) => {
      this.pendingSkillSyncs.set(sessionId, { resolve, reject });
    });
    this.deps.registry.sendToLocalClients(userId, wsEvent('skill_sync_required', sessionId, {
      syncUrl, removed, workspace: session.workspace ?? '',
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 60_000);
        }),
      ]);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Skill sync failed for session ${sessionId}: ${message}`);
      return false;
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
    if (skillSync) skillSync.reject(new Error('Session aborted'));
    const mcpSync = this.pendingMcpSyncs.get(sessionId);
    if (mcpSync) mcpSync.reject(new Error('Session aborted'));
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

  private async finishCompletedSession(sessionId: number, userId: number, executionId: string): Promise<void> {
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session?.phase === 'CANCELLED') return;
    await this.deps.taskTerminalService.finishExecution(sessionId, userId, 'COMPLETED', executionId);
  }

  private async finishFailedSession(sessionId: number, userId: number, executionId: string, reason: string): Promise<void> {
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session?.phase === 'CANCELLED') return;
    await this.deps.taskTerminalService.finishExecution(sessionId, userId, 'FAILED', executionId, reason);
  }

  private async finishCancelledSession(sessionId: number, userId: number, executionId: string): Promise<void> {
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session && this.isTerminalPhase(session.phase)) return;
    await this.deps.sessionService.cleanupIncompleteTail(sessionId);
    await this.deps.taskTerminalService.finishExecution(sessionId, userId, 'CANCELLED', executionId);
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

  private parseUserIdFromToken(token: string | undefined): number | null {
    if (!token) return null;
    try {
      // WS 与 REST 同权：接受 access/shell，拒绝 refresh token 充当连接凭据
      if (!this.deps.jwtService.validateAccessToken(token)) return null;
      return this.deps.jwtService.getUserIdFromToken(token);
    } catch {
      return null;
    }
  }

  private normalizeClient(client: string | undefined): string {
    if (client?.toLowerCase() === 'electron') return 'electron';
    if (client?.toLowerCase() === 'android') return 'android';
    if (client?.toLowerCase() === 'cli') return 'cli';
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
