import type { Session } from './types.js';
import type { SessionService } from './session.service.js';
import type { StreamingWsRegistry } from './ws/streaming-ws-registry.js';
import { delivered } from './ws/streaming-ws-registry.js';
import { wsEvent } from './ws/ws-event.js';
import type { SessionTreeSignalPublisher } from '../harness/approval/session-tree-signal-publisher.js';
import type { TaskNotificationDeliveryService } from '../notification/task/delivery.service.js';
import type { TaskNotificationDelivery } from '../notification/task/types.js';
import type { ExtractionSessionInput } from '../memory/memory-extraction.service.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import { isFeishuChannelSession } from '../harness/tool/feishu-channel-tool.js';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** 记忆抽取依赖（可选注入；接口化避免 session 域反向依赖 memory 域实现）。 */
export interface MemoryExtractionInvoker {
  extractForSession(input: ExtractionSessionInput): Promise<void>;
}

export class TaskTerminalService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly registry: StreamingWsRegistry,
    private readonly deliveryService: TaskNotificationDeliveryService,
    private readonly treeSignalPublisher: SessionTreeSignalPublisher,
    private readonly notificationExecutor: (fn: () => void | Promise<void>) => void = (fn) => {
      void Promise.resolve().then(fn);
    },
    private readonly memoryExtraction?: MemoryExtractionInvoker | null,
    private readonly memoryExecutor: (fn: () => void | Promise<void>) => void = (fn) => {
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

    // 微信/飞书通道会话由机器人等外部触发，终态不计未读，与 updatePhase 的 DB 写入保持一致
    const statusData: Record<string, unknown> = {
      phase,
      unread: session.projectKey !== WEIXIN_PROJECT_KEY && !isFeishuChannelSession(session.projectKey, session.workspace),
    };
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

    this.dispatchMemoryExtraction(session, phase);
  }

  /**
   * 任务收尾自动沉淀记忆（技术方案 5.6）：仅 COMPLETED 主会话派发（FAILED/CANCELLED、
   * SUBAGENT/SIDE_TASK 不抽取），fire-and-forget，绝不影响上方任务完成事件链；
   * 用户开关在抽取服务内部判断。直接复用本方法已查得的 session 对象，不追加查询。
   */
  private dispatchMemoryExtraction(session: Session, phase: string): void {
    if (phase !== 'COMPLETED') return;
    if (session.sessionType === 'SUBAGENT' || session.sessionType === 'SIDE_TASK') return;
    const extraction = this.memoryExtraction;
    if (extraction == null) return;
    try {
      this.memoryExecutor(() => {
        // 兜底 catch：抽取服务内部虽已全量吞异常，这里再保一道，确保 fire-and-forget
        // 不会产生 unhandled rejection 或同步抛出破坏任务完成事件链
        void Promise.resolve()
          .then(() => extraction.extractForSession({
            sessionId: session.id!,
            userId: session.userId,
            projectKey: session.projectKey ?? null,
            workspace: session.workspace ?? null,
            agentId: session.agentId ?? null,
          }))
          .catch((e) => {
            console.warn(`[memory-extraction] dispatch failed sessionId=${session.id}: ${(e as Error).message}`);
          });
      });
    } catch (e) {
      // executor 本身（线程池饱和拒绝等）同步抛错也不能影响任务完成事件链
      console.warn(`[memory-extraction] submit failed sessionId=${session.id}: ${(e as Error).message}`);
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
