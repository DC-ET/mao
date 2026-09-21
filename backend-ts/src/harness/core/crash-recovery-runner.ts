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
  /** 恢复续跑成功结束时的终态通知（如飞书进度卡片 PATCH「已完成」）。 */
  complete?(finalContent: string): Promise<boolean>;
  /** 恢复续跑失败时的终态通知（如飞书进度卡片 PATCH「已失败」）。 */
  fail?(message: string): Promise<boolean>;
}

export class CrashRecoveryRunner {
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 初始扫描时被推迟恢复的会话快照。蓝绿部署下延迟恢复首次只重放该快照，不重新扫描
   * DB——否则会把「重启后刚创建并正在活跃执行的会话」误判为崩溃遗留的 RUNNING 会话，
   * 对同一会话再次启动一次 harness 执行，造成消息重复执行。
   * 快照重放完成后（runPass 内）会触发一次全库补扫（deferredScan），此时部署窗口
   * 已过、旧实例已停，补扫兜住「窗口内新建、随后随旧实例排空死亡」的漏网会话。
   */
  private deferredCandidates: Session[] = [];
  /** 延迟恢复是否已完成快照后的全库补扫（仅补扫一次，避免把活跃会话误判为遗留）。 */
  private deferredScan = false;
  /**
   * 本实例正在恢复中的会话。延迟恢复的「快照重放」与随后的「全库补扫」两轮可能命中同一会话：
   * 首轮恢复已把 phase 置回 RUNNING，recoverSession 的 phase 重查无法识别，会对同一会话
   * 并发跑两次 harness 执行（同一批消息重复执行、终态互相覆盖）。
   */
  private readonly recovering = new Set<number>();
  /** 快照重放与全库补扫的间隔秒数：补扫前旧实例 drain 必须已收尾。 */
  private static readonly RESCAN_DELAY_SEC = 15;

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
    /**
     * 本实例内存中是否正在执行该会话（如 AgentLoop 已挂 cancel flag）。
     * 延迟全库补扫据此排除「本实例正常执行中」的会话——它们 phase 同样是 RUNNING，
     * 仅凭 DB 无法与崩溃遗留区分，不排除会对同一会话并发跑两次执行。
     */
    private readonly isSessionLocallyActive?: (sessionId: number) => boolean,
  ) {}

  async run(): Promise<void> {
    await this.runPass(false);
  }

  private async runPass(deferred: boolean): Promise<void> {
    const deployLock = readDeployLock(this.runtimeDir);
    const recentDeploy = isRecentDeployLock(deployLock);
    const deferAll = !deferred && shouldDeferAllRecoveryDuringDeploy(deployLock);
    const skipDeployActive = !deferred && recentDeploy;
    // 蓝绿部署窗口内不得执行子代理协调器恢复：协调器会直接 claim RUNNING 中的
    // 子代理 execution 并重跑父会话，绕过 deploy defer 守卫导致新旧实例对同一会话
    // 双实例并发执行。统一推迟到 deferred pass（此时 deployLock 已过窗口）。
    const deferCoordinator = !deferred && (deferAll || skipDeployActive);
    const blocked = !deferCoordinator && this.subagentCoordinator
      ? await this.subagentCoordinator.schedule((session) => this.recoverSession(session))
      : new Set<number>();
    // 延迟恢复分两步：首次 pass 只重放初始扫描快照（deferredScan=false），避免把
    // 重启后新建的活跃会话误判为崩溃遗留；第二次 pass（deferredScan=true，旧实例
    // drain 收尾后触发）做全库补扫，兜住「部署窗口内新建、随旧实例排空死亡」的会话。
    const candidates = deferred && !this.deferredScan
      ? this.deferredCandidates
      : await this.collectCandidates(blocked, deferred && this.deferredScan);
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
    } else if (skipped.length > 0) {
      // 蓝绿部署中仍在排空实例上活跃的会话：记录快照，延迟恢复只重试这批，不重新全库扫描。
      this.deferredCandidates = skipped;
      harnessLog(
        'info',
        `Skipping crash recovery for ${skipped.length} session(s) still active on draining instance during blue-green deploy`,
      );
    }
    // 部署窗口内必须调度一次延迟恢复，哪怕初始扫描候选为空：会话可能在旧实例上创建、
    // 恰在 drain 时才随旧实例被 kill，新实例启动时刻扫描根本看不到它（phase 尚未写入），
    // 只有延迟恢复的全库补扫能兜住这类漏网会话。
    if (!deferred && recentDeploy) {
      this.scheduleDeferredRecovery(deployDrainSec(deployLock));
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
  private async collectCandidates(blocked: Set<number>, excludeLocallyActive = false): Promise<Session[]> {
    const running = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('RUNNING') : [];
    const resuming = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('RESUMING') : [];
    return [...running, ...resuming].filter((session, index, all) =>
      session.sessionType !== 'SUBAGENT'
      && session.id != null
      && !blocked.has(session.id)
      // 本实例已在恢复中的会话：其 phase 被恢复流程置为 RUNNING，重查无法与「崩溃遗留」区分
      && !this.recovering.has(session.id)
      // 全库补扫时排除本实例正常执行中的会话：它们 phase 同样为 RUNNING，但并非崩溃遗留，
      // 纳入会对同一会话并发跑两次 harness 执行。
      && !(excludeLocallyActive && this.isSessionLocallyActive?.(session.id) === true)
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
      // 第一步：重放初始扫描快照（此时 deferredScan 仍为 false，runPass 用快照作候选）。
      void this.runPass(true).then(() => {
        // 第二步：快照重放完成后置位并延迟一轮全库补扫——此时旧实例 drain 已收尾，
        // 补扫才能安全捕获窗口内新建、随旧实例排空死亡但不在快照里的会话。
        if (!this.deferredScan) {
          this.deferredScan = true;
          this.deferredTimer = setTimeout(() => {
            this.deferredTimer = null;
            void this.runPass(true).catch((e) => harnessLog('error', 'Post-drain crash rescan failed', e));
          }, CrashRecoveryRunner.RESCAN_DELAY_SEC * 1000);
        }
      }).catch((e) => harnessLog('error', 'Deferred crash recovery failed', e));
    }, delaySec * 1000);
  }

  private async recoverSession(snapshot: Session): Promise<void> {
    const sessionId = snapshot.id!;
    // 同一实例内的恢复去重：延迟恢复的快照重放与全库补扫两轮可能命中同一会话，
    // 首轮已把 phase 置回 RUNNING，靠下面的 phase 重查无法拦住并发第二次执行。
    if (this.recovering.has(sessionId)) {
      harnessLog('info', `Skip recovery for session ${sessionId}: recovery already in flight`);
      return;
    }
    this.recovering.add(sessionId);
    try {
      await this.runRecovery(snapshot, sessionId);
    } finally {
      this.recovering.delete(sessionId);
    }
  }

  private async runRecovery(snapshot: Session, sessionId: number): Promise<void> {
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
        harnessLog('info', `Session ${sessionId}: filled ${deleted} missing tool output(s)`);
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
        // 成功终态必须 PATCH 飞书进度卡片：执行中的 round/tool 事件不会把卡片收成「已完成」，
        // 漏掉 complete 会让蓝绿/重启后续跑成功后卡片永久停在「正在处理」。
        try { await extra?.complete?.(await this.latestAssistantReply(sessionId)); } catch (e) {
          harnessLog('warn', `Recovery extra complete failed for session ${sessionId}`, e);
        }
      }
      harnessLog('info', `Session ${sessionId}: recovery completed`);
    } catch (e) {
      // 恢复续跑异常：额外监听（如飞书卡片）同步收到 FAILED 终态，避免停留在「正在处理」。
      const failMessage = (e as Error).message ?? 'Recovery failed';
      try {
        if (extra?.fail != null) await extra.fail(failMessage);
        else extra?.onError(e);
      } catch { /* extra 已尽力 */ }
      harnessLog('error', `Recovery failed for session ${sessionId}`, e);
      terminalPhase = 'FAILED';
      try {
        await this.taskTerminalService.finishExecution(
          sessionId, userId, 'FAILED', executionId, failMessage);
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

  private async latestAssistantReply(sessionId: number): Promise<string> {
    const messages = await this.sessionService.getMessages?.(sessionId) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'ASSISTANT') continue;
      const text = this.sessionService.extractVisibleText?.(message.content ?? null) ?? message.content;
      if (text != null && text.trim() !== '') return text;
    }
    return '任务已完成。';
  }

  private async resolveSupportsVision(session: Session): Promise<boolean> {
    let model = session.modelId != null ? await this.llmModelMapper.selectById(session.modelId) : null;
    if (model == null && this.llmModelMapper.selectDefault) {
      model = await this.llmModelMapper.selectDefault();
    }
    return boolish(model?.supportsVision) === true;
  }
}
