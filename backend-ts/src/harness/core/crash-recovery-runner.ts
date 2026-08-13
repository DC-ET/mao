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

export class CrashRecoveryRunner {
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
    private readonly agentExecutor: { submit(fn: () => Promise<void>): void } = {
      submit: (fn) => { void fn(); },
    },
    private readonly onExecutionFinished?: (sessionId: number, userId: number) => Promise<void>,
  ) {}

  async run(): Promise<void> {
    const stale = this.sessionMapper.selectByPhase
      ? await this.sessionMapper.selectByPhase('RUNNING')
      : [];
    if (stale.length === 0) return;
    harnessLog('warn', `Found ${stale.length} sessions stuck in RUNNING after restart, initiating recovery`);
    for (const session of stale) {
      this.agentExecutor.submit(() => this.recoverSession(session));
    }
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
      this.notifyClient(userId, sessionId, 'RESUMING');
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
