import type { SessionMapper, SessionService, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import { harnessLog } from '../log.js';
import type { ApprovalHint } from './approval-hint.js';

export class ApprovalRegistry {
  private readonly pending = new Map<number, Set<string>>();
  /** 「总是允许」hint 存储会话内挂起的审批请求，key = `${sessionId}:${requestId}`。 */
  private readonly hints = new Map<string, ApprovalHint>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly sessionMapper: SessionMapper,
    private readonly streamingWsRegistry: StreamingWsRegistry,
  ) {}

  async register(sessionId: number | null, requestId: string | null, hint?: ApprovalHint | null): Promise<void> {
    if (sessionId == null || requestId == null) return;
    if (hint != null) {
      // 同 requestId 重发场景下后写覆盖前写；unregister/takeHint 时清除
      this.hints.set(`${sessionId}:${requestId}`, hint);
    }
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
    // 双 unregister 清理点之一（本处 + LocalToolExecutor finally）：hint 必须同步清除，
    // 否则超时/断连后陈旧帧仍可消费出规则
    this.hints.delete(`${sessionId}:${requestId}`);
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

  /**
   * 取回并清除 hint（恰好一次消费）：alwaysAllow 回包时由 handleToolApproval 调用。
   * 取不到（后端重启内存清空 / 900s 超时已 unregister / 同帧重发已消费）→ 返回 null，
   * 调用方静默忽略 alwaysAllow 只执行，不建规则。
   */
  takeHint(sessionId: number, requestId: string): ApprovalHint | null {
    const key = `${sessionId}:${requestId}`;
    const hint = this.hints.get(key) ?? null;
    if (hint) this.hints.delete(key);
    return hint;
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
