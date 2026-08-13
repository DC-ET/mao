import type { SessionMapper, SessionService, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import { harnessLog } from '../log.js';

export class ApprovalRegistry {
  private readonly pending = new Map<number, Set<string>>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly sessionMapper: SessionMapper,
    private readonly streamingWsRegistry: StreamingWsRegistry,
  ) {}

  async register(sessionId: number | null, requestId: string | null): Promise<void> {
    if (sessionId == null || requestId == null) return;
    let ids = this.pending.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.pending.set(sessionId, ids);
    }
    const first = ids.size === 0;
    ids.add(requestId);
    if (first) {
      const entered = await this.sessionService.enterWaitingApproval(sessionId);
      if (entered) await this.publishPhase(sessionId, 'WAITING_APPROVAL');
      harnessLog('debug', `Session ${sessionId} entered WAITING_APPROVAL (requestId=${requestId}, entered=${entered})`);
    }
  }

  async unregister(sessionId: number | null, requestId: string | null): Promise<void> {
    if (sessionId == null || requestId == null) return;
    const ids = this.pending.get(sessionId);
    if (!ids) return;
    ids.delete(requestId);
    const empty = ids.size === 0;
    if (empty) this.pending.delete(sessionId);
    if (empty) {
      const restored = await this.sessionService.restoreRunningAfterApproval(sessionId);
      if (restored) await this.publishPhase(sessionId, 'RUNNING');
    }
  }

  countForSession(sessionId: number | null): number {
    if (sessionId == null) return 0;
    return this.pending.get(sessionId)?.size ?? 0;
  }

  countForSessionIds(sessionIds: Iterable<number> | null): Map<number, number> {
    const result = new Map<number, number>();
    if (!sessionIds) return result;
    for (const sid of sessionIds) {
      const c = this.countForSession(sid);
      if (c > 0) result.set(sid, c);
    }
    return result;
  }

  private async publishPhase(sessionId: number, phase: string): Promise<void> {
    const session = await this.sessionMapper.selectById(sessionId);
    if (!session?.userId) return;
    this.streamingWsRegistry.send(session.userId, wsEvent('session_status', sessionId, { phase }));
    this.streamingWsRegistry.send(session.userId, wsEvent('session_list_update', sessionId, { phase }));
  }
}
