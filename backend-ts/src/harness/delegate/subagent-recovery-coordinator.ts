import type { SubagentExecution } from '../../session/types.js';
import type { Session, SessionCompactionService, SessionMapper, SessionService } from '../deps.js';
import { harnessLog } from '../log.js';
import type { SubagentExecutionMapper } from './subagent-execution.mapper.js';
import type { SubagentExecutionRecoveryService } from './subagent-execution-recovery.service.js';
import type { SubagentResultDeliveryService } from './subagent-result-delivery.service.js';

export class SubagentRecoveryCoordinator {
  constructor(
    private readonly executionMapper: SubagentExecutionMapper,
    private readonly recoveryService: SubagentExecutionRecoveryService,
    private readonly deliveryService: SubagentResultDeliveryService,
    private readonly sessionMapper: SessionMapper,
    private readonly sessionService: SessionService,
    private readonly compactionService: SessionCompactionService,
    private readonly executor: { submit(fn: () => Promise<void>): void },
  ) {}

  async schedule(recoverParent: (session: Session) => Promise<void>): Promise<Set<number>> {
    const candidates = await this.executionMapper.listRecoveryCandidates();
    const groups = new Map<number, SubagentExecution[]>();
    const blocked = new Set<number>();
    for (const execution of candidates) {
      if (execution.parentSessionId == null) continue;
      const rows = groups.get(execution.parentSessionId) ?? [];
      rows.push(execution);
      groups.set(execution.parentSessionId, rows);
      blocked.add(execution.parentSessionId);
      if (execution.childSessionId != null) blocked.add(execution.childSessionId);
    }
    harnessLog('info', `subagent_recovery_scan executions=${candidates.length} parents=${groups.size}`);
    for (const [parentId, executions] of groups) {
      this.executor.submit(() => this.recoverGroup(parentId, executions, recoverParent));
    }
    return blocked;
  }

  private async recoverGroup(
    parentId: number, executions: SubagentExecution[], recoverParent: (session: Session) => Promise<void>,
  ): Promise<void> {
    harnessLog('info', `parent_recovery_wait parent=${parentId} childExecutions=${executions.map((row) => row.id).join(',')}`);
    let parent = await this.sessionMapper.selectById(parentId);
    if (!parent || isTerminal(parent.phase)) {
      await this.suppressParent(parentId, executions);
      return;
    }
    await Promise.all(executions.map(async (execution) => {
      if (!['RUNNING', 'RECOVERING'].includes(execution.status ?? '')) return;
      try {
        await this.recoveryService.recover(execution);
      } catch (error) {
        harnessLog('error', `Subagent recovery escaped executionId=${execution.id}`, error);
      }
    }));
    parent = await this.sessionMapper.selectById(parentId);
    if (!parent || isTerminal(parent.phase)) {
      await this.suppressParent(parentId, executions);
      return;
    }
    // 先投递真实结果，再补占位。反过来的话，占位 TOOL 会让 deliver 以为配对已完整，
    // 父会话续跑时读到的是「结果丢失」而不是子代理输出。
    for (const execution of [...executions].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
      if (execution.id != null) await this.deliveryService.deliver(execution.id);
    }
    const compaction = await this.compactionService.loadValidated(parentId);
    const boundary = this.compactionService.boundaryOf(compaction);
    await this.sessionService.cleanupIncompleteTailAfterId?.(parentId, boundary);
    parent = await this.sessionMapper.selectById(parentId);
    if (!parent || isTerminal(parent.phase)) {
      await this.suppressParent(parentId, executions);
      return;
    }
    harnessLog('info', `parent_recovery_start parent=${parentId}`);
    await recoverParent(parent);
  }

  /** 父会话已终态：抑制投递，并把仍停在运行中的子会话收成取消。 */
  private async suppressParent(parentId: number, executions: SubagentExecution[]): Promise<void> {
    await this.deliveryService.suppressForParent(parentId);
    for (const execution of executions) {
      const childId = execution.childSessionId;
      if (childId == null) continue;
      const child = await this.sessionMapper.selectById(childId);
      if (!child || isTerminal(child.phase)) continue;
      await this.sessionService.updatePhase(childId, 'CANCELLED');
    }
  }
}

function isTerminal(phase: string | null | undefined): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}
