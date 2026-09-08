import type { WsEvent } from './ws-event.js';

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

export class StreamingWsRegistry {
  private readonly outboundQueue: OutboundItem[] = [];
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
  }

  getOutboundQueueSize(): number {
    return this.outboundQueue.length;
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

  send(userId: number, event: WsEvent): void {
    this.enqueue(userId, event, 'ALL');
  }

  sendWithResult(userId: number, event: WsEvent): Promise<WsDeliveryResult> {
    return new Promise((resolve) => {
      if (userId == null || event == null) {
        resolve({ targetCount: 0, successCount: 0, failureCount: 0 });
        return;
      }
      if (this.outboundQueue.length >= this.capacity) {
        console.warn(`WS outbound queue full, dropping tracked event type=${event.type} for userId=${userId}`);
        resolve({ targetCount: 0, successCount: 0, failureCount: 0 });
        return;
      }
      this.outboundQueue.push({ userId, event, rawJson: null, target: 'ALL', resultFuture: { resolve } });
      this.flushNow();
    });
  }

  sendToLocalClients(userId: number, event: WsEvent): void {
    this.enqueue(userId, event, 'LOCAL_ONLY');
  }

  sendRaw(userId: number, json: string): void {
    if (userId == null || json == null) return;
    if (this.outboundQueue.length >= this.capacity) {
      console.warn(`WS outbound queue full, dropping raw message for userId=${userId}`);
      return;
    }
    this.outboundQueue.push({ userId, event: null, rawJson: json, target: 'ALL', resultFuture: null });
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

  private enqueue(userId: number, event: WsEvent, target: SendTarget): void {
    if (userId == null || event == null) return;
    if (this.outboundQueue.length >= this.capacity) {
      console.warn(`WS outbound queue full (capacity reached), dropping event type=${event.type} for userId=${userId}`);
      return;
    }
    this.outboundQueue.push({ userId, event, rawJson: null, target, resultFuture: null });
    this.flushNow();
  }

  private scheduleDrain(): void {
    if (!this.running) return;
    this.drainTimer = setTimeout(() => {
      this.flushNow();
      this.scheduleDrain();
    }, 50);
  }

  private flushNow(): void {
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
