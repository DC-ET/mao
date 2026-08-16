import type { SessionRepository } from '../../session/session.repository.js';
import type { StreamingWsRegistry } from '../../session/ws/streaming-ws-registry.js';
import { wsEvent } from '../../session/ws/ws-event.js';
import type { ApprovalRegistry } from './approval-registry.js';
import type { AskUserQuestionsRegistry } from '../tool/ask-user-questions-registry.js';

function isRunningPhase(phase: string | null | undefined): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING';
}

export class SessionTreeSignalPublisher {
  private readonly publishEpoch = new Map<number, number>();

  constructor(
    private readonly sessionMapper?: SessionRepository,
    private readonly approvalRegistry?: ApprovalRegistry,
    private readonly askUserQuestionsRegistry?: AskUserQuestionsRegistry,
    private readonly streamingWsRegistry?: StreamingWsRegistry,
  ) {}

  publishIfSideTask(sessionId: number | null | undefined): Promise<void> {
    if (sessionId == null || !this.sessionMapper) return Promise.resolve();
    return this.sessionMapper.selectById(sessionId).then((s) => {
      if (s == null || s.sessionType !== 'SIDE_TASK' || s.parentSessionId == null) return;
      return this.publish(s.parentSessionId);
    }).catch(() => undefined);
  }

  publishForSession(sessionId: number | null | undefined): Promise<void> {
    if (sessionId == null || !this.sessionMapper) return Promise.resolve();
    return this.sessionMapper.selectById(sessionId).then((s) => {
      if (s == null) return;
      if (s.sessionType === 'SIDE_TASK' && s.parentSessionId != null) {
        return this.publish(s.parentSessionId);
      }
      return this.publish(sessionId);
    }).catch(() => undefined);
  }

  publish(parentSessionId: number): Promise<void> {
    if (!this.sessionMapper || !this.approvalRegistry || !this.askUserQuestionsRegistry || !this.streamingWsRegistry) {
      return Promise.resolve();
    }
    const epoch = (this.publishEpoch.get(parentSessionId) ?? 0) + 1;
    this.publishEpoch.set(parentSessionId, epoch);
    return this.publishAsync(parentSessionId, epoch).catch((e) => {
      console.warn(`Failed to publish session_tree_status for ${parentSessionId}: ${(e as Error).message}`);
    });
  }

  private async publishAsync(parentSessionId: number, epoch: number): Promise<void> {
    const parent = await this.sessionMapper!.selectById(parentSessionId);
    if (parent == null || parent.userId == null) return;
    if (this.publishEpoch.get(parentSessionId) !== epoch) return;
    const sides = await this.sessionMapper!.listSideTasks(parentSessionId);
    if (this.publishEpoch.get(parentSessionId) !== epoch) return;
    const allIds = [parentSessionId, ...sides.map((st) => st.id!).filter((id) => id != null)];
    const approvalCounts = this.approvalRegistry!.countForSessionIds(allIds);
    const questionCounts = this.askUserQuestionsRegistry!.countPendingBySessionIds(allIds);

    let approval = approvalCounts.get(parentSessionId) ?? 0;
    let question = questionCounts.get(parentSessionId) ?? 0;
    let unread = parent.unread === 1;
    let running = isRunningPhase(parent.phase);
    let failed = parent.phase === 'FAILED';

    for (const st of sides) {
      approval += approvalCounts.get(st.id!) ?? 0;
      question += questionCounts.get(st.id!) ?? 0;
      unread = unread || st.unread === 1;
      running = running || isRunningPhase(st.phase);
      failed = failed || st.phase === 'FAILED';
    }

    if (this.publishEpoch.get(parentSessionId) !== epoch) return;
    this.streamingWsRegistry!.send(parent.userId, wsEvent('session_tree_status', parentSessionId, {
      treePendingApprovalCount: approval,
      treePendingQuestionCount: question,
      treeUnread: unread,
      treeRunning: running,
      treeFailed: failed,
    }));
  }
}
