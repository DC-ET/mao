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
      await this.deliveryService.suppressForParent(parentId);
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
      await this.deliveryService.suppressForParent(parentId);
      return;
    }
    const compaction = await this.compactionService.loadValidated(parentId);
    const boundary = this.compactionService.boundaryOf(compaction);
    await this.sessionService.cleanupIncompleteTailAfterId?.(parentId, boundary);
    for (const execution of [...executions].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
      if (execution.id != null) await this.deliveryService.deliver(execution.id);
    }
    parent = await this.sessionMapper.selectById(parentId);
    if (!parent || isTerminal(parent.phase)) {
      await this.deliveryService.suppressForParent(parentId);
      return;
    }
    harnessLog('info', `parent_recovery_start parent=${parentId}`);
    await recoverParent(parent);
  }
}

function isTerminal(phase: string | null | undefined): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}
