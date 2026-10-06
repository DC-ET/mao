import type { SessionRepository } from '../../session/session.repository.js';
import type { StreamingWsRegistry } from '../../session/ws/streaming-ws-registry.js';
import { wsEvent } from '../../session/ws/ws-event.js';
import type { ApprovalRegistry } from './approval-registry.js';
import type { AskUserQuestionsRegistry } from '../tool/ask-user-questions-registry.js';

function isRunningPhase(phase: string | null | undefined): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING';
}

/** 沿父链上溯的防御深度上限：仅防病态数据（环 / 超深链），正常树 1-3 层。 */
const ROOT_WALK_DEPTH_LIMIT = 10;

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
      return this.publishAtRoot(sessionId);
    }).catch(() => undefined);
  }

  publishForSession(sessionId: number | null | undefined): Promise<void> {
    if (sessionId == null || !this.sessionMapper) return Promise.resolve();
    return this.sessionMapper.selectById(sessionId).then((s) => {
      if (s == null) return;
      if (s.sessionType === 'SIDE_TASK' && s.parentSessionId != null) {
        return this.publishAtRoot(sessionId);
      }
      return this.publish(sessionId);
    }).catch(() => undefined);
  }

  /**
   * 从 fromSessionId（边路任务或其任一层父会话）沿父链上溯到根主会话，
   * 在根上聚合并发布唯一一份 session_tree_status。
   * 链路中断（父已删除的孤儿）或根不是主会话则不发——孤儿从树上不可达，无消费场景。
   */
  publishAtRoot(fromSessionId: number): Promise<void> {
    if (fromSessionId == null || !this.sessionMapper) return Promise.resolve();
    return this.resolveRootSessionId(fromSessionId).then((rootId) => {
      if (rootId == null) return;
      return this.publish(rootId);
    }).catch(() => undefined);
  }

  /** 根解析：正常链终点是 parent 为 null 的主会话；中途断链 / 成环 / 根仍是边路（异常数据）返回 null。 */
  private async resolveRootSessionId(fromSessionId: number): Promise<number | null> {
    if (!this.sessionMapper) return null;
    let currentId = fromSessionId;
    const visited = new Set<number>([currentId]);
    for (let depth = 0; depth <= ROOT_WALK_DEPTH_LIMIT; depth++) {
      const current = await this.sessionMapper.selectById(currentId);
      if (current == null) return null;
      if (current.parentSessionId == null) {
        return current.sessionType === 'SIDE_TASK' ? null : current.id ?? null;
      }
      const parentId = current.parentSessionId;
      if (visited.has(parentId)) return null;
      visited.add(parentId);
      currentId = parentId;
    }
    return null;
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
    // 全后代聚合（含深层边路任务），与 /side-tasks?recursive=1、enrichSessions 首刷口径一致
    const sides = await this.sessionMapper!.listDescendantSideTasks(parentSessionId);
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
