import { randomUUID } from 'node:crypto';
import type { SessionMapper, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import { harnessLog } from '../log.js';

export interface PendingLocalToolRequest {
  requestId: string | null;
  future: Promise<string>;
  resolve: (v: string) => void;
}

export class LocalToolSessionRegistry {
  private readonly sessionToUser = new Map<number, number>();
  private readonly pendingRequests = new Map<number, Map<string, { resolve: (v: string) => void }>>();

  constructor(
    private readonly streamingWsRegistry: StreamingWsRegistry,
    private readonly sessionMapper: SessionMapper,
  ) {}

  setUserForSession(sessionId: number, userId: number): void {
    const existing = this.sessionToUser.get(sessionId);
    if (existing === userId) return;
    if (existing != null && existing !== userId) {
      harnessLog('warn', `Session ${sessionId} already registered to user ${existing}, re-registering to user ${userId}`);
      this.failAllPending(sessionId, 'Session re-registered to different user');
    }
    this.sessionToUser.set(sessionId, userId);
  }

  removeSession(sessionId: number): void {
    this.sessionToUser.delete(sessionId);
    this.failAllPending(sessionId, 'Session unregistered');
  }

  failAllForUser(userId: number): void {
    const sessions: number[] = [];
    for (const [sid, uid] of this.sessionToUser) {
      if (uid === userId) sessions.push(sid);
    }
    for (const sid of sessions) {
      this.sessionToUser.delete(sid);
      this.failAllPending(sid, 'User disconnected');
    }
  }

  async isConnected(sessionId: number | null): Promise<boolean> {
    const userId = await this.resolveUserId(sessionId);
    return userId != null && this.streamingWsRegistry.hasLocalClientConnection(userId);
  }

  getUserIdForSession(sessionId: number | null): Promise<number | null> {
    return this.resolveUserId(sessionId);
  }

  async resolveUserId(sessionId: number | null): Promise<number | null> {
    if (sessionId == null) return null;
    const cached = this.sessionToUser.get(sessionId);
    if (cached != null) return cached;
    const session = await this.sessionMapper.selectById(sessionId);
    if (!session) return null;
    if (session.userId != null) return session.userId;
    if (session.sessionType === 'SUBAGENT' && session.parentSessionId != null) {
      return this.sessionToUser.get(session.parentSessionId) ?? null;
    }
    return null;
  }

  async sendToolRequest(
    sessionId: number | null,
    toolName: string,
    argumentsJson: string,
    workspace: string | null | undefined,
    needApproval: boolean,
    dangerReason: string | null,
  ): Promise<PendingLocalToolRequest> {
    const userId = await this.resolveUserId(sessionId);
    if (userId == null || !this.streamingWsRegistry.hasLocalClientConnection(userId)) {
      return {
        requestId: null,
        future: Promise.resolve(JSON.stringify({ error: 'Local client is not connected' })),
        resolve: () => {},
      };
    }
    const requestId = randomUUID();
    let resolve!: (v: string) => void;
    const future = new Promise<string>((r) => { resolve = r; });
    if (sessionId != null) {
      let map = this.pendingRequests.get(sessionId);
      if (!map) {
        map = new Map();
        this.pendingRequests.set(sessionId, map);
      }
      map.set(requestId, { resolve });
    }
    const payload: Record<string, unknown> = {
      requestId,
      toolName,
      arguments: argumentsJson ?? '{}',
      workspace: workspace ?? '',
      needApproval,
    };
    if (dangerReason != null) payload.dangerReason = dangerReason;
    this.streamingWsRegistry.sendToLocalClients(userId, wsEvent('tool_execute', sessionId, payload));
    return { requestId, future, resolve };
  }

  completeToolRequest(sessionId: number, requestId: string, result: string): void {
    const map = this.pendingRequests.get(sessionId);
    const entry = map?.get(requestId);
    if (entry) {
      map!.delete(requestId);
      entry.resolve(result);
    }
  }

  completeToolRequestError(sessionId: number, requestId: string, error: string): void {
    const map = this.pendingRequests.get(sessionId);
    const entry = map?.get(requestId);
    if (entry) {
      map!.delete(requestId);
      entry.resolve(JSON.stringify({ error: error.replace(/"/g, "'") }));
    }
  }

  failAllForSession(sessionId: number): void {
    this.failAllPending(sessionId, 'Session aborted');
  }

  private failAllPending(sessionId: number, reason: string): void {
    const map = this.pendingRequests.get(sessionId);
    this.pendingRequests.delete(sessionId);
    if (map) {
      for (const entry of map.values()) {
        entry.resolve(JSON.stringify({ error: reason }));
      }
    }
  }
}
