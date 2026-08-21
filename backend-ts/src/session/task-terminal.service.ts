import type { Session } from './types.js';
import type { SessionService } from './session.service.js';
import type { StreamingWsRegistry } from './ws/streaming-ws-registry.js';
import { delivered } from './ws/streaming-ws-registry.js';
import { wsEvent } from './ws/ws-event.js';
import type { SessionTreeSignalPublisher } from '../harness/approval/session-tree-signal-publisher.js';
import type { TaskNotificationDeliveryService } from '../notification/task/delivery.service.js';
import type { TaskNotificationDelivery } from '../notification/task/types.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export class TaskTerminalService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly registry: StreamingWsRegistry,
    private readonly deliveryService: TaskNotificationDeliveryService,
    private readonly treeSignalPublisher: SessionTreeSignalPublisher,
    private readonly notificationExecutor: (fn: () => void | Promise<void>) => void = (fn) => {
      void Promise.resolve().then(fn);
    },
  ) {}

  async finishExecution(
    sessionId: number,
    userId: number | null | undefined,
    phase: string,
    executionId: string,
    failureReason?: string | null,
  ): Promise<void> {
    if (!TERMINAL.has(phase)) {
      throw new Error(`Unsupported terminal phase: ${phase}`);
    }
    const previous = await this.sessionService.getSession(sessionId);
    if (isTerminalPhase(previous.phase)) {
      console.info(
        `Ignoring terminal transition for already-terminal session: sessionId=${sessionId}, from=${previous.phase}, to=${phase}`,
      );
      return;
    }
    // FAILED 时将错误信息持久化到 runtimeStatusJson，刷新后前端可恢复
    if (phase === 'FAILED' && failureReason != null && failureReason.trim().length > 0) {
      await this.sessionService.updateRuntimeStatus(sessionId, { executionError: failureReason });
    } else {
      await this.sessionService.updateRuntimeStatus(sessionId, null);
    }
    await this.sessionService.updatePhase(sessionId, phase);
    await this.sessionService.markLastMessageFinished(sessionId);
    const session = await this.sessionService.getSession(sessionId);
    const ownerId = userId ?? session.userId;

    // 微信通道会话由定时任务等机器触发，终态不计未读，与 updatePhase 的 DB 写入保持一致
    const statusData: Record<string, unknown> = { phase, unread: session.projectKey !== WEIXIN_PROJECT_KEY };
    if (executionId != null && executionId.trim() !== '') {
      statusData.executionId = executionId;
    }

    const delivery = await this.prepareDelivery(session, phase, executionId, failureReason ?? null);
    if (ownerId != null) {
      this.registry.send(ownerId, wsEvent('session_list_update', sessionId, { phase }));
      void this.registry.sendWithResult(ownerId, wsEvent('session_status', sessionId, statusData)).then((result) => {
        if (delivery == null) return;
        this.notificationExecutor(async () => {
          try {
            await this.deliveryService.resolveWebSocket(delivery, delivered(result));
          } catch (e) {
            console.warn(
              `Failed to resolve WS result for task notification: deliveryId=${delivery.id}, error=${(e as Error).message}`,
            );
          }
        });
      });
    }

    if (session.sessionType === 'SIDE_TASK' && session.parentSessionId != null) {
      this.treeSignalPublisher.publish(session.parentSessionId);
    } else if (session.sessionType !== 'SUBAGENT') {
      // 主任务自身进入终态时也要重算并下发 treeRunning，否则前端列表里的
      // treeRunning 会停留在旧值（true），导致蓝色“执行中”圆点不转绿。
      this.treeSignalPublisher.publish(sessionId);
    }
  }

  private async prepareDelivery(
    session: Session,
    phase: string,
    executionId: string,
    failureReason: string | null,
  ): Promise<TaskNotificationDelivery | null> {
    try {
      return await this.deliveryService.prepare(session as never, phase, executionId, failureReason);
    } catch (e) {
      console.warn(`Failed to prepare task notification delivery: sessionId=${session.id}, error=${(e as Error).message}`);
      return null;
    }
  }
}

function isTerminalPhase(phase: string | null | undefined): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}
