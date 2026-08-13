import type { WsEvent } from './ws-event.js';

export interface WsSocket {
  id: string;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const WS_OPEN = 1;

export interface WsDeliveryResult {
  targetCount: number;
  successCount: number;
  failureCount: number;
}

export function delivered(result: WsDeliveryResult): boolean {
  return result.successCount > 0;
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

  private readonly userSessions = new Map<number, Set<WsSocket>>();
  private readonly sessionToUser = new Map<string, number>();
  private readonly sessionToClientType = new Map<string, string>();
  private readonly userSubscriptions = new Map<number, Set<number>>();

  constructor(outboundQueueCapacity = 10000) {
    this.capacity = outboundQueueCapacity;
    this.scheduleDrain();
  }

  shutdown(): void {
    this.running = false;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  getOutboundQueueSize(): number {
    return this.outboundQueue.length;
  }

  register(session: WsSocket, userId: number, clientType: string | null | undefined): void {
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
    return sessions != null && [...sessions].some((s) => s.readyState === WS_OPEN);
  }

  hasLocalClientConnection(userId: number): boolean {
    const sessions = this.userSessions.get(userId);
    return sessions != null && [...sessions].some(
      (s) => s.readyState === WS_OPEN && this.sessionToClientType.get(s.id) === 'electron',
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
      : [...sessions].filter((s) => this.sessionToClientType.get(s.id) === 'electron');
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
      if (session.readyState === WS_OPEN) {
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
    return 'browser';
  }
}
