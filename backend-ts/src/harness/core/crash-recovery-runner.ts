import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import { boolish, wsEvent } from '../deps.js';
import type {
  ActivityService, LlmModelMapper, Session, SessionActivityHeartbeat, SessionMapper,
  SessionService, StreamingWsRegistry, TaskTerminalService,
} from '../deps.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { AgentLoop } from './agent-loop.js';
import type { HarnessService } from './harness-service.js';
import { CompositeAgentEventListener } from './composite-agent-event-listener.js';
import type { SessionTodoMapper } from '../todo/session-todo.mapper.js';
import type { SubagentRecoveryCoordinator } from '../delegate/subagent-recovery-coordinator.js';
import {
  deployDrainSec,
  isRecentDeployLock,
  isSessionActiveDuringDeploy,
  readDeployLock,
  shouldDeferAllRecoveryDuringDeploy,
} from './deploy-lock.js';

export interface RecoveryExtraListener extends AgentEventListener {
  /** 恢复续跑被取消时的终态通知（如飞书进度卡片 PATCH「已取消」）。 */
  cancel?(interrupted?: boolean): Promise<boolean>;
}

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
    private readonly onExecutionFinished?: (sessionId: number, userId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>,
    private readonly subagentCoordinator?: SubagentRecoveryCoordinator,
    /** 恢复续跑时的额外事件监听（如飞书进度卡片续更）；返回 null 表示该会话无需额外监听。 */
    private readonly createExtraListeners?: (sessionId: number, userId: number | null, executionId: string) => Promise<RecoveryExtraListener | null>,
  ) {}

  async run(): Promise<void> {
    await this.runPass(false);
  }

  private async runPass(deferred: boolean): Promise<void> {
    const deployLock = readDeployLock(this.runtimeDir);
    const deferAll = !deferred && shouldDeferAllRecoveryDuringDeploy(deployLock);
    const skipDeployActive = !deferred && isRecentDeployLock(deployLock);
    // 蓝绿部署窗口内不得执行子代理协调器恢复：协调器会直接 claim RUNNING 中的
    // 子代理 execution 并重跑父会话，绕过 deploy defer 守卫导致新旧实例对同一会话
    // 双实例并发执行。统一推迟到 deferred pass（此时 deployLock 已过窗口）。
    const deferCoordinator = !deferred && (deferAll || skipDeployActive);
    const blocked = !deferCoordinator && this.subagentCoordinator
      ? await this.subagentCoordinator.schedule((session) => this.recoverSession(session))
      : new Set<number>();
    // 延迟恢复复用初始扫描快照，避免把重启后新建的活跃会话误判为崩溃遗留会话。
    const candidates = deferred ? this.deferredCandidates : await this.collectCandidates(blocked);
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

  private async recoverSession(snapshot: Session): Promise<void> {
    const sessionId = snapshot.id!;
    const userId = snapshot.userId ?? null;
    let extra: RecoveryExtraListener | null = null;
    // 恢复前重查当前状态：候选来自启动时（或延迟恢复的初始）快照，蓝绿排空期间
    // 会话可能已被旧实例正常收尾进入终态，直接重放会把已完成会话误判为 FAILED。
    const current = await this.sessionMapper.selectById(sessionId);
    if (current == null || (current.phase !== 'RUNNING' && current.phase !== 'RESUMING')) {
      harnessLog('info', `Skip recovery for session ${sessionId}: current phase=${current?.phase ?? 'deleted'}`);
      return;
    }
    const session = current;
    const executionId = randomUUID();
    // 恢复续跑的实际终态：默认 FAILED，供收尾回调（onExecutionFinished）按终态决定队列是否接力消费。
    let terminalPhase: 'COMPLETED' | 'FAILED' | 'CANCELLED' = 'FAILED';
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
      // 挂载额外监听（如飞书进度卡片）：失败不阻断恢复，仅丢失该次续跑的卡片续更。
      try {
        extra = await this.createExtraListeners?.(sessionId, userId, executionId) ?? null;
      } catch (e) {
        harnessLog('warn', `Recovery extra listener failed for session ${sessionId}`, e);
      }
      harnessLog('info', `Session ${sessionId}: starting recovery execution`);
      await this.sessionService.updatePhase(sessionId, 'RUNNING');
      this.notifyClient(userId, sessionId, 'RUNNING');
      const executionListener = extra == null ? listener as never : CompositeAgentEventListener.of(listener, extra);
      await this.harnessService.execute(sessionId, null, executionListener as never, cancelFlag);
      if (cancelFlag.get()) {
        try { await extra?.cancel?.(); } catch (e) {
          harnessLog('warn', `Recovery extra cancel failed for session ${sessionId}`, e);
        }
        await this.taskTerminalService.finishExecution(sessionId, userId, 'CANCELLED', executionId);
        terminalPhase = 'CANCELLED';
      } else {
        await this.taskTerminalService.finishExecution(sessionId, userId, 'COMPLETED', executionId);
        terminalPhase = 'COMPLETED';
      }
      harnessLog('info', `Session ${sessionId}: recovery completed`);
    } catch (e) {
      // 恢复续跑异常：额外监听（如飞书卡片）同步收到 FAILED 终态，避免停留在「正在处理」。
      try { extra?.onError(e); } catch { /* extra 已尽力 */ }
      harnessLog('error', `Recovery failed for session ${sessionId}`, e);
      terminalPhase = 'FAILED';
      try {
        await this.taskTerminalService.finishExecution(
          sessionId, userId, 'FAILED', executionId, (e as Error).message ?? 'Recovery failed');
      } catch { /* ignore */ }
    } finally {
      this.agentLoop.removeCancelFlag(sessionId);
      this.activityHeartbeat.clear(sessionId);
      if (userId != null) {
        try {
          await this.onExecutionFinished?.(sessionId, userId, terminalPhase);
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
