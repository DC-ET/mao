import type { WsEvent } from './ws-event.js';

import { wsEvent } from './ws-event.js';

export interface WsSocket {
  id: string;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const WS_OPEN = 1;

/** 能作为 LOCAL 模式本机执行端的 WS client 类型。 */
export const LOCAL_CAPABLE_CLIENTS = new Set(['electron', 'cli']);

export interface WsDeliveryResult {
  targetCount: number;
  successCount: number;
  failureCount: number;
}

export function delivered(result: WsDeliveryResult): boolean {
  return result.successCount > 0;
}

export interface WsAuthMetadata {
  userId: number;
  authSource?: string;
  expiresAt: number;
}

interface ConnectionAuth {
  metadata: WsAuthMetadata;
  timer: ReturnType<typeof setTimeout> | null;
  refreshes: Map<string, number>;
}

type SendTarget = 'ALL' | 'LOCAL_ONLY';

interface OutboundItem {
  userId: number;
  event: WsEvent | null;
  rawJson: string | null;
  target: SendTarget;
  resultFuture: { resolve: (r: WsDeliveryResult) => void } | null;
}

/**
 * 关键帧类型：终态、错误与工具结果。队列满时增量帧（content_delta / thinking_delta 等）可丢，
 * 这些帧一旦丢失，客户端等待方（pendingCallbacks / activeExecutionIds / 执行态）会永久悬挂，
 * 因此必须与普通帧分队列存放，不受普通队列容量限制。
 */
const CRITICAL_EVENT_TYPES = new Set([
  'session_status',
  'message_end',
  'message_start',
  'error',
  'cancelled',
  'tool_call_result',
  'ask_user_questions',
  'ask_user_questions_cancelled',
  'queue_updated',
  'queue_message_consumed',
  'session_already_running',
  // 收件箱未读数：普通帧队列满时是直接丢弃，弱网/高频会话下未读数会静默停在旧值
  // 且无主动重拉入口；事件日均为个位数到数十条，不会挤占关键通道。
  'inbox_updated',
  // 后台子代理完成通知：丢失后客户端只能等下次 REST 重拉（刷新/切会话）才补上卡片，
  // 用户盯屏期间完全看不到通知。事件量与 inbox_updated 同量级。
  'assistant_message_saved',
]);

function isCriticalItem(item: OutboundItem): boolean {
  return item.event != null && CRITICAL_EVENT_TYPES.has(item.event.type);
}

export class StreamingWsRegistry {
  /** 增量帧队列：容量有限，满则可丢弃（丢一帧文本不影响执行态收敛）。 */
  private readonly outboundQueue: OutboundItem[] = [];
  /** 关键帧队列：不受 capacity 限制，满时优先保证这些帧送达。 */
  private readonly criticalQueue: OutboundItem[] = [];
  private readonly capacity: number;
  private running = true;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly connectionAuth = new Map<string, ConnectionAuth>();
  private readonly closedConnections = new WeakSet<WsSocket>();
  private readonly userSessions = new Map<number, Set<WsSocket>>();
  private readonly sessionToUser = new Map<string, number>();
  private readonly sessionToClientType = new Map<string, string>();
  private readonly userSubscriptions = new Map<number, Set<number>>();
  private readonly activeToolCalls = new Map<number, Map<string, Record<string, unknown>>>();
  /** 当前处于思考阶段（thinking_start ~ thinking_end）的会话，重连快照恢复用。 */
  private readonly thinkingSessions = new Set<number>();
  /** 会话当前在途执行的 executionId：订阅快照据此把新 executionId 告知重连客户端（含崩溃恢复、通道入站等不经 WS handler 提交的执行）。 */
  private readonly sessionExecutions = new Map<number, string>();
  /** agent sessionId → 绑定的 embed 连接（页面执行端）。每个会话只绑定一个页面连接。 */
  private readonly embedSessionBindings = new Map<number, WsSocket>();
  /** embed 连接 → 该连接绑定的 agent sessionId 集合（断线清理用）。 */
  private readonly embedConnectionSessions = new Map<string, Set<number>>();

  constructor(outboundQueueCapacity = 10000) {
    this.capacity = outboundQueueCapacity;
    this.scheduleDrain();
  }

  shutdown(): void {
    this.running = false;
    for (const auth of this.connectionAuth.values()) {
      if (auth.timer) clearTimeout(auth.timer);
    }
    this.connectionAuth.clear();
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    // 停机时仍在队列里的关键帧必须给等待方一个确定结果，否则 sendWithResult 的
    // resultFuture 永不 resolve，调用方的通知抑制/状态回写会被永久挂起。
    for (const item of [...this.criticalQueue, ...this.outboundQueue]) {
      if (item.resultFuture) {
        item.resultFuture.resolve({ targetCount: 0, successCount: 0, failureCount: 0 });
      }
    }
    this.criticalQueue.length = 0;
    this.outboundQueue.length = 0;
  }

  getOutboundQueueSize(): number {
    return this.outboundQueue.length + this.criticalQueue.length;
  }

  register(session: WsSocket, userId: number, clientType: string | null | undefined, metadata?: WsAuthMetadata): void {
    if (this.closedConnections.has(session)) return;
    const previous = this.connectionAuth.get(session.id);
    if (previous?.timer) clearTimeout(previous.timer);
    this.connectionAuth.delete(session.id);
    if (metadata) {
      const auth: ConnectionAuth = { metadata: { ...metadata }, timer: null, refreshes: new Map() };
      this.connectionAuth.set(session.id, auth);
      this.scheduleAuthExpiry(session, auth);
    }
    this.sessionToUser.set(session.id, userId);
    this.sessionToClientType.set(session.id, this.normalizeClientType(clientType));
    let set = this.userSessions.get(userId);
    if (!set) {
      set = new Set();
      this.userSessions.set(userId, set);
    }
    set.add(session);
    console.info(`WS stream registered: userId=${userId}, wsSessionId=${session.id}, clientType=${this.sessionToClientType.get(session.id)}`);
  }

  unregister(session: WsSocket): void {
    this.closedConnections.add(session);
    const auth = this.connectionAuth.get(session.id);
    if (auth?.timer) clearTimeout(auth.timer);
    this.connectionAuth.delete(session.id);
    this.releaseEmbedConnection(session);
    const userId = this.sessionToUser.get(session.id);
    this.sessionToUser.delete(session.id);
    this.sessionToClientType.delete(session.id);
    if (userId != null) {
      const sessions = this.userSessions.get(userId);
      if (sessions) {
        sessions.delete(session);
        if (sessions.size === 0) {
          this.userSessions.delete(userId);
          this.userSubscriptions.delete(userId);
        }
      }
    }
  }

  /** 收发入口均检查墙上时间，不依赖到期回调获得调度。 */
  isConnectionAuthorized(session: WsSocket): boolean {
    if (this.closedConnections.has(session)) return false;
    const auth = this.connectionAuth.get(session.id);
    if (auth?.metadata.authSource === 'company_sso' && auth.metadata.expiresAt <= Date.now()) {
      this.closeConnection(session, 'Authentication expired');
      return false;
    }
    return true;
  }

  closeConnection(session: WsSocket, reason: string): void {
    if (this.closedConnections.has(session)) return;
    this.closedConnections.add(session);
    const auth = this.connectionAuth.get(session.id);
    if (auth?.timer) clearTimeout(auth.timer);
    this.connectionAuth.delete(session.id);
    session.close(1003, reason);
  }

  getRefreshResult(session: WsSocket, requestId: string): number | undefined {
    return this.connectionAuth.get(session.id)?.refreshes.get(requestId);
  }

  /** 调用方提供已验证元数据；同步完成校验、替换及计时器更新。 */
  refreshAuthentication(session: WsSocket, requestId: string, metadata: WsAuthMetadata): boolean {
    if (!this.isConnectionAuthorized(session)) return false;
    const auth = this.connectionAuth.get(session.id);
    if (!auth || metadata.userId !== auth.metadata.userId
      || metadata.authSource !== auth.metadata.authSource || metadata.expiresAt <= Date.now()) return false;
    if (auth.refreshes.has(requestId)) return true;
    auth.metadata = { ...metadata };
    auth.refreshes.set(requestId, metadata.expiresAt);
    this.scheduleAuthExpiry(session, auth);
    return true;
  }

  /** 认证确认只属于当前连接，不能广播到同一用户的其他客户端。 */
  sendToConnection(session: WsSocket, frame: unknown): void {
    if (this.isConnectionAuthorized(session) && session.readyState === WS_OPEN) {
      session.send(JSON.stringify(frame));
    }
  }

  private scheduleAuthExpiry(session: WsSocket, auth: ConnectionAuth): void {
    if (auth.timer) clearTimeout(auth.timer);
    auth.timer = null;
    if (auth.metadata.authSource !== 'company_sso') return;
    auth.timer = setTimeout(() => {
      auth.timer = null;
      if (this.isConnectionAuthorized(session)) this.scheduleAuthExpiry(session, auth);
    }, Math.max(0, Math.min(auth.metadata.expiresAt - Date.now(), 2_147_483_647)));
    auth.timer.unref?.();
  }

  subscribe(userId: number, sessionId: number): void {
    let set = this.userSubscriptions.get(userId);
    if (!set) {
      set = new Set();
      this.userSubscriptions.set(userId, set);
    }
    set.add(sessionId);
  }

  unsubscribe(userId: number, sessionId: number): void {
    this.userSubscriptions.get(userId)?.delete(sessionId);
  }

  isSubscribed(userId: number, sessionId: number): boolean {
    return this.userSubscriptions.get(userId)?.has(sessionId) ?? false;
  }

  trackActiveToolCall(sessionId: number, executionId: string, toolCallId: string, toolName: string, args: string): void {
    if (!toolCallId) return;
    let calls = this.activeToolCalls.get(sessionId);
    if (!calls) {
      calls = new Map();
      this.activeToolCalls.set(sessionId, calls);
    }
    calls.set(toolCallId, {
      tool_call_id: toolCallId,
      tool_name: toolName,
      arguments: args,
      executionId,
    });
  }

  updateActiveToolCallArguments(sessionId: number, toolCallId: string, args: string): void {
    const call = this.activeToolCalls.get(sessionId)?.get(toolCallId);
    if (call) call.arguments = args;
  }

  completeActiveToolCall(sessionId: number, toolCallId: string): void {
    const calls = this.activeToolCalls.get(sessionId);
    if (!calls) return;
    calls.delete(toolCallId);
    if (calls.size === 0) this.activeToolCalls.delete(sessionId);
  }

  getActiveToolCalls(sessionId: number): Array<Record<string, unknown>> {
    return [...(this.activeToolCalls.get(sessionId)?.values() ?? [])].map((call) => ({ ...call }));
  }

  clearActiveToolCalls(sessionId: number): void {
    this.activeToolCalls.delete(sessionId);
  }

  /** 会话当前是否处于模型思考阶段（thinking_start / thinking_end 之间），供断线重连快照恢复。 */
  isSessionThinking(sessionId: number): boolean {
    return this.thinkingSessions.has(sessionId);
  }

  setSessionThinking(sessionId: number, thinking: boolean): void {
    if (thinking) this.thinkingSessions.add(sessionId);
    else this.thinkingSessions.delete(sessionId);
  }

  /** 执行启动时登记当前 executionId（WsStreamingEventListener 构造时调用）。 */
  setSessionExecution(sessionId: number, executionId: string): void {
    if (executionId === '') return;
    this.sessionExecutions.set(sessionId, executionId);
  }

  getSessionExecution(sessionId: number): string | undefined {
    return this.sessionExecutions.get(sessionId);
  }

  /** 执行终态时清除，避免订阅快照回放已结束执行的 executionId。 */
  clearSessionExecution(sessionId: number): void {
    this.sessionExecutions.delete(sessionId);
  }

  send(userId: number, event: WsEvent): void {
    this.enqueue(userId, event, 'ALL');
  }

  sendWithResult(userId: number, event: WsEvent): Promise<WsDeliveryResult> {
    return new Promise((resolve) => {
      if (userId == null || event == null) {
        resolve({ targetCount: 0, successCount: 0, failureCount: 0 });
        return;
      }
      // 已跟踪（等待 resultFuture）的事件一律走关键队列：等待方必须拿到确定结果，
      // 不能因普通队列满而被静默丢弃成「假成功」。
      this.enqueueItem({ userId, event, rawJson: null, target: 'ALL', resultFuture: { resolve } });
    });
  }

  sendToLocalClients(userId: number, event: WsEvent): void {
    this.enqueue(userId, event, 'LOCAL_ONLY');
  }

  getClientType(session: WsSocket): string | null {
    return this.sessionToClientType.get(session.id) ?? null;
  }

  /**
   * 把 agent 会话绑定到具体的 embed 连接（浏览器标签页/页面实例）。
   * 页面工具请求只发往该连接，同一用户的其他标签页不会收到，也不会接管结果。
   */
  bindEmbedSession(sessionId: number, session: WsSocket): void {
    const previous = this.embedSessionBindings.get(sessionId);
    if (previous && previous !== session) {
      this.embedConnectionSessions.get(previous.id)?.delete(sessionId);
    }
    this.embedSessionBindings.set(sessionId, session);
    let sessions = this.embedConnectionSessions.get(session.id);
    if (!sessions) {
      sessions = new Set();
      this.embedConnectionSessions.set(session.id, sessions);
    }
    sessions.add(sessionId);
  }

  unbindEmbedSession(sessionId: number, session: WsSocket): void {
    if (this.embedSessionBindings.get(sessionId) === session) {
      this.embedSessionBindings.delete(sessionId);
    }
    this.embedConnectionSessions.get(session.id)?.delete(sessionId);
  }

  getEmbedSessionConnection(sessionId: number): WsSocket | null {
    const socket = this.embedSessionBindings.get(sessionId);
    if (!socket) return null;
    if (socket.readyState !== WS_OPEN || !this.isConnectionAuthorized(socket)) return null;
    return socket;
  }

  /** 原始绑定（不检查连接是否 OPEN）：换绑时用于识别被顶掉的旧连接。 */
  getEmbedSessionBinding(sessionId: number): WsSocket | null {
    return this.embedSessionBindings.get(sessionId) ?? null;
  }

  isEmbedSession(sessionId: number): boolean {
    return this.getEmbedSessionConnection(sessionId) != null;
  }

  /** 某 embed 连接当前绑定的 agent 会话（断线时用于清理 pending 页面请求）。 */
  getEmbedSessionsForConnection(session: WsSocket): number[] {
    return [...(this.embedConnectionSessions.get(session.id) ?? [])];
  }

  private releaseEmbedConnection(session: WsSocket): void {
    const sessions = this.embedConnectionSessions.get(session.id);
    if (!sessions) return;
    this.embedConnectionSessions.delete(session.id);
    for (const sessionId of sessions) {
      if (this.embedSessionBindings.get(sessionId) === session) {
        this.embedSessionBindings.delete(sessionId);
      }
    }
  }

  /** 定向发送页面工具请求；返回是否成功投递到绑定的页面连接。 */
  sendPageToolRequest(sessionId: number, requestId: string, tool: string, args: unknown): boolean {
    const socket = this.getEmbedSessionConnection(sessionId);
    if (!socket) return false;
    this.sendToConnection(socket, wsEvent('page_tool_request', sessionId, { requestId, tool, arguments: args }));
    return true;
  }

  sendRaw(userId: number, json: string): void {
    if (userId == null || json == null) return;
    // 只入队、不立即冲刷：raw 帧沿用增量帧语义，由后续 send / 定时 drain 驱动投递，
    // 到期检查发生在 deliver 入口（与改造前一致）。
    if (this.outboundQueue.length < this.capacity) {
      this.outboundQueue.push({ userId, event: null, rawJson: json, target: 'ALL', resultFuture: null });
    } else {
      console.warn(`WS outbound queue full (capacity reached), dropping raw message for userId=${userId}`);
    }
  }

  hasConnection(userId: number): boolean {
    const sessions = this.userSessions.get(userId);
    return sessions != null && [...sessions].some((s) => s.readyState === WS_OPEN && this.isConnectionAuthorized(s));
  }

  hasLocalClientConnection(userId: number): boolean {
    const sessions = this.userSessions.get(userId);
    return sessions != null && [...sessions].some(
      (s) => s.readyState === WS_OPEN && this.isConnectionAuthorized(s) && LOCAL_CAPABLE_CLIENTS.has(this.sessionToClientType.get(s.id) ?? ''),
    );
  }

  getSubscribedSessionIds(userId: number): Set<number> {
    const subs = this.userSubscriptions.get(userId);
    return subs ? new Set(subs) : new Set();
  }

  getUserId(session: WsSocket): number | null {
    return this.sessionToUser.get(session.id) ?? null;
  }

  /**
   * 统一入队：关键帧（终态 / 错误 / 结果 / 已跟踪事件）走独立关键队列，不受 capacity 限制；
   * 增量帧走普通队列，满时才丢弃——丢一帧文本不会让客户端的执行态失去收敛路径。
   */
  private enqueueItem(item: OutboundItem): void {
    if (item.userId == null) return;
    if (item.event == null && item.rawJson == null) return;
    if (isCriticalItem(item) || item.resultFuture != null) {
      this.criticalQueue.push(item);
    } else if (this.outboundQueue.length >= this.capacity) {
      console.warn(`WS outbound queue full (capacity reached), dropping event type=${item.event?.type} for userId=${item.userId}`);
      return;
    } else {
      this.outboundQueue.push(item);
    }
    this.flushNow();
  }

  private enqueue(userId: number, event: WsEvent, target: SendTarget): void {
    this.enqueueItem({ userId, event, rawJson: null, target, resultFuture: null });
  }

  private scheduleDrain(): void {
    if (!this.running) return;
    this.drainTimer = setTimeout(() => {
      this.flushNow();
      this.scheduleDrain();
    }, 50);
  }

  private flushNow(): void {
    // 关键帧优先冲刷，保证积压时终态/错误帧仍能及时到达并释放等待方。
    while (this.criticalQueue.length > 0) {
      this.deliver(this.criticalQueue.shift()!);
    }
    while (this.outboundQueue.length > 0) {
      const item = this.outboundQueue.shift()!;
      this.deliver(item);
    }
  }

  private deliver(item: OutboundItem): void {
    const sessions = this.userSessions.get(item.userId);
    if (!sessions || sessions.size === 0) {
      this.completeResult(item, 0, 0, 0);
      return;
    }
    const targets = item.target === 'ALL'
      ? [...sessions]
      : [...sessions].filter((s) => LOCAL_CAPABLE_CLIENTS.has(this.sessionToClientType.get(s.id) ?? ''));
    if (targets.length === 0) {
      this.completeResult(item, 0, 0, 0);
      return;
    }
    let json: string;
    if (item.rawJson != null) {
      json = item.rawJson;
    } else {
      try {
        json = JSON.stringify(item.event);
      } catch {
        this.completeResult(item, targets.length, 0, targets.length);
        return;
      }
    }
    let targetCount = 0;
    let successCount = 0;
    let failureCount = 0;
    for (const session of targets) {
      if (session.readyState === WS_OPEN && this.isConnectionAuthorized(session)) {
        targetCount++;
        try {
          session.send(json);
          successCount++;
        } catch {
          failureCount++;
        }
      }
    }
    this.completeResult(item, targetCount, successCount, failureCount);
  }

  private completeResult(item: OutboundItem, targetCount: number, successCount: number, failureCount: number): void {
    item.resultFuture?.resolve({ targetCount, successCount, failureCount });
  }

  private normalizeClientType(clientType: string | null | undefined): string {
    if (clientType?.toLowerCase() === 'electron') return 'electron';
    if (clientType?.toLowerCase() === 'android') return 'android';
    if (clientType?.toLowerCase() === 'cli') return 'cli';
    // 与 StreamingWsHandler.normalizeClient 口径一致：embed 连接不应被记成 browser
    if (clientType?.toLowerCase() === 'embed') return 'embed';
    return 'browser';
  }
}
