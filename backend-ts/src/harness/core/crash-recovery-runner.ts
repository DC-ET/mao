import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import { boolish, wsEvent } from '../deps.js';
import type {
  ActivityService, LlmModelMapper, Session, SessionActivityHeartbeat, SessionMapper,
  SessionService, StreamingWsRegistry, TaskTerminalService,
} from '../deps.js';
import type { AgentLoop } from './agent-loop.js';
import type { HarnessService } from './harness-service.js';
import type { SessionTodoMapper } from '../todo/session-todo.mapper.js';
import type { SubagentRecoveryCoordinator } from '../delegate/subagent-recovery-coordinator.js';
import {
  deployDrainSec,
  isRecentDeployLock,
  isSessionActiveDuringDeploy,
  readDeployLock,
  shouldDeferAllRecoveryDuringDeploy,
} from './deploy-lock.js';

export class CrashRecoveryRunner {
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 初始扫描时被推迟恢复的会话快照。蓝绿部署下延迟恢复若重新扫描 DB，
   * 会把「重启后刚创建并正在活跃执行的会话」误判为崩溃遗留的 RUNNING 会话，
   * 从而对同一会话再次启动一次 harness 执行，造成消息重复执行（飞书已回复但任务一直运行中）。
   * 因此延迟恢复只复用初始扫描的快照，不再重新扫描。
   */
  private deferredCandidates: Session[] = [];

  constructor(
    private readonly sessionMapper: SessionMapper,
    private readonly sessionService: SessionService,
    private readonly taskTerminalService: TaskTerminalService,
    private readonly harnessService: HarnessService,
    private readonly agentLoop: AgentLoop,
    private readonly registry: StreamingWsRegistry,
    private readonly activityService: ActivityService,
    private readonly activityHeartbeat: SessionActivityHeartbeat,
    private readonly sessionTodoMapper: SessionTodoMapper,
    private readonly llmModelMapper: LlmModelMapper,
    private readonly runtimeDir: string,
    private readonly agentExecutor: { submit(fn: () => Promise<void>): void } = {
      submit: (fn) => { void fn(); },
    },
    private readonly onExecutionFinished?: (sessionId: number, userId: number) => Promise<void>,
    private readonly subagentCoordinator?: SubagentRecoveryCoordinator,
  ) {}

  async run(): Promise<void> {
    await this.runPass(false);
  }

  private async runPass(deferred: boolean): Promise<void> {
    const blocked = this.subagentCoordinator
      ? await this.subagentCoordinator.schedule((session) => this.recoverSession(session))
      : new Set<number>();
    // 延迟恢复复用初始扫描快照，避免把重启后新建的活跃会话误判为崩溃遗留会话。
    const candidates = deferred ? this.deferredCandidates : await this.collectCandidates(blocked);

    const deployLock = readDeployLock(this.runtimeDir);
    const deferAll = !deferred && shouldDeferAllRecoveryDuringDeploy(deployLock);
    const skipDeployActive = !deferred && isRecentDeployLock(deployLock);
    const { recover, skipped } = deferAll
      ? { recover: [], skipped: candidates }
      : this.partitionForDeploy(candidates, skipDeployActive, deployLock);

    if (deferAll && candidates.length > 0) {
      // 快照被推迟的会话，供延迟恢复复用，避免重新扫描 DB 误抓重启后新建的活跃会话。
      this.deferredCandidates = candidates;
      harnessLog(
        'info',
        `Deferring crash recovery for ${candidates.length} session(s) during blue-green deploy (status=${deployLock?.status})`,
      );
      if (deployLock != null) {
        this.scheduleDeferredRecovery(deployDrainSec(deployLock));
      }
    } else if (skipped.length > 0) {
      // 蓝绿部署中仍在排空实例上活跃的会话：记录快照，延迟恢复只重试这批，不重新全库扫描。
      this.deferredCandidates = skipped;
      harnessLog(
        'info',
        `Skipping crash recovery for ${skipped.length} session(s) still active on draining instance during blue-green deploy`,
      );
      if (!deferred && deployLock != null) {
        this.scheduleDeferredRecovery(deployDrainSec(deployLock));
      }
    }

    if (recover.length === 0) return;
    const label = deferred ? 'deferred' : 'initial';
    harnessLog('warn', `Found ${recover.length} sessions stuck in RUNNING after restart, initiating ${label} recovery`);
    for (const session of recover) this.agentExecutor.submit(() => this.recoverSession(session));
  }

  /**
   * 从 DB 收集崩溃遗留的 RUNNING/RESUMING 会话候选（排除子代理、被协调器阻塞的会话），
   * 并按 session.id 去重。
   */
  private async collectCandidates(blocked: Set<number>): Promise<Session[]> {
    const running = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('RUNNING') : [];
    const resuming = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('RESUMING') : [];
    return [...running, ...resuming].filter((session, index, all) =>
      session.sessionType !== 'SUBAGENT'
      && session.id != null
      && !blocked.has(session.id)
      && all.findIndex((item) => item.id === session.id) === index);
  }

  private partitionForDeploy(
    candidates: Session[],
    skipDeployActive: boolean,
    deployLock: ReturnType<typeof readDeployLock>,
  ): { recover: Session[]; skipped: Session[] } {
    if (!skipDeployActive || deployLock == null) {
      return { recover: candidates, skipped: [] };
    }
    const recover: Session[] = [];
    const skipped: Session[] = [];
    for (const session of candidates) {
      if (isSessionActiveDuringDeploy(session, deployLock)) skipped.push(session);
      else recover.push(session);
    }
    return { recover, skipped };
  }

  private scheduleDeferredRecovery(delaySec: number): void {
    if (this.deferredTimer != null) return;
    harnessLog('info', `Scheduling deferred crash recovery in ${delaySec}s after blue-green drain`);
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      void this.runPass(true).catch((e) => harnessLog('error', 'Deferred crash recovery failed', e));
    }, delaySec * 1000);
  }

  private async recoverSession(session: Session): Promise<void> {
    const sessionId = session.id!;
    const userId = session.userId ?? null;
    const executionId = randomUUID();
    try {
      const deleted = await this.sessionService.cleanupIncompleteTail(sessionId);
      if (deleted > 0) {
        harnessLog('info', `Session ${sessionId}: cleaned up ${deleted} incomplete tail messages`);
      }
      await this.sessionService.updatePhase(sessionId, 'RESUMING');
      this.notifyClient(userId, sessionId, 'RUNNING');
      const cancelFlag = this.agentLoop.registerCancelFlag(sessionId);
      const { WsStreamingEventListener } = await import('../../session/ws/ws-streaming-event-listener.js');
      const listener = new WsStreamingEventListener({
        registry: this.registry as never,
        activityService: this.activityService as never,
        activityHeartbeat: this.activityHeartbeat,
        sessionTodoMapper: this.sessionTodoMapper,
        sessionService: this.sessionService as never,
      }, sessionId, userId ?? 0, executionId, await this.resolveSupportsVision(session));
      harnessLog('info', `Session ${sessionId}: starting recovery execution`);
      await this.sessionService.updatePhase(sessionId, 'RUNNING');
      this.notifyClient(userId, sessionId, 'RUNNING');
      await this.harnessService.execute(sessionId, null, listener as never, cancelFlag);
      if (cancelFlag.get()) {
        await this.taskTerminalService.finishExecution(sessionId, userId, 'CANCELLED', executionId);
      } else {
        await this.taskTerminalService.finishExecution(sessionId, userId, 'COMPLETED', executionId);
      }
      harnessLog('info', `Session ${sessionId}: recovery completed`);
    } catch (e) {
      harnessLog('error', `Recovery failed for session ${sessionId}`, e);
      try {
        await this.taskTerminalService.finishExecution(
          sessionId, userId, 'FAILED', executionId, (e as Error).message ?? 'Recovery failed');
      } catch { /* ignore */ }
    } finally {
      this.agentLoop.removeCancelFlag(sessionId);
      this.activityHeartbeat.clear(sessionId);
      if (userId != null) {
        try {
          await this.onExecutionFinished?.(sessionId, userId);
        } catch (e) {
          harnessLog('warn', `Auto-consume after recovery failed for session ${sessionId}`, e);
        }
      }
    }
  }

  private notifyClient(userId: number | null, sessionId: number, phase: string): void {
    if (userId == null) return;
    try {
      const isTerminal = phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
      const statusData = isTerminal ? { phase, unread: true } : { phase };
      this.registry.send(userId, wsEvent('session_status', sessionId, statusData));
      this.registry.send(userId, wsEvent('session_list_update', sessionId, { phase }));
    } catch { /* client may not be connected */ }
  }

  private async resolveSupportsVision(session: Session): Promise<boolean> {
    let model = session.modelId != null ? await this.llmModelMapper.selectById(session.modelId) : null;
    if (model == null && this.llmModelMapper.selectDefault) {
      model = await this.llmModelMapper.selectDefault();
    }
    return boolish(model?.supportsVision) === true;
  }
}
