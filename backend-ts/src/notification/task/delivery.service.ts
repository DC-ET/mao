import { randomUUID } from 'node:crypto';
import { formatDateTime } from '../../common/json.js';
import { hasText } from '../../common/case.js';
import type { MessageQueueItem, Session } from '../../domain/types.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import { DeliveryStatus, type TaskNotificationDelivery } from './types.js';
import type { TaskNotificationPreferenceService } from './preference.service.js';

export interface DeliveryStore {
  insert(row: TaskNotificationDelivery): Promise<number>;
  updateById(row: Partial<TaskNotificationDelivery> & { id: number }): Promise<void>;
  updateIfStatus?(
    id: number,
    expectedStatus: string,
    row: Partial<TaskNotificationDelivery>,
  ): Promise<boolean>;
}

export interface QueueLister {
  listPending(sessionId: number): Promise<MessageQueueItem[]>;
}

export interface TaskNotificationMetrics {
  created(channel: string, phase: string): void;
  suppressedByWebSocket(channel: string): void;
  sent(channel: string, result: string): void;
  retried(channel: string): void;
  pending(count: number): void;
}

export class InMemoryTaskNotificationMetrics implements TaskNotificationMetrics {
  created(): void {}
  suppressedByWebSocket(): void {}
  sent(): void {}
  retried(): void {}
  pending(): void {}
}

export class TaskNotificationDeliveryService {
  constructor(
    private readonly store: DeliveryStore,
    private readonly preferenceService: TaskNotificationPreferenceService,
    private readonly queueService: QueueLister,
    private readonly metrics: TaskNotificationMetrics = new InMemoryTaskNotificationMetrics(),
  ) {}

  async prepare(session: Session | null, phase: string, executionId: string | null, failureReason: string | null): Promise<TaskNotificationDelivery | null> {
    if (session == null || (phase !== 'COMPLETED' && phase !== 'FAILED')) {
      return null;
    }
    if (session.sessionType === 'SUBAGENT') {
      return null;
    }
    if (session.projectKey === WEIXIN_PROJECT_KEY) {
      console.debug(`Skipping task notification for weixin session: sessionId=${session.id}`);
      return null;
    }
    if ((await this.queueService.listPending(session.id!)).length > 0) {
      return null;
    }
    const preference = await this.preferenceService.findEnabled(session.userId!);
    if (preference == null) {
      return null;
    }
    const resolvedExecutionId = !hasText(executionId) ? randomUUID() : executionId!;
    const eventKey = `${session.id}:${resolvedExecutionId}:${phase}`;
    const delivery: TaskNotificationDelivery = {
      eventKey,
      userId: session.userId!,
      sessionId: session.id,
      executionId: resolvedExecutionId,
      terminalPhase: phase,
      channel: preference.channel!,
      webhookCiphertext: preference.webhookCiphertext!,
      titleSnapshot: this.normalizeTitle(session.title),
      status: DeliveryStatus.WAITING_WS,
      attemptCount: 0,
      nextRetryAt: formatDateTime(new Date(Date.now() + 10_000)),
    };
    if (phase === 'FAILED' && hasText(failureReason)) {
      delivery.failureReason = this.truncate(failureReason!, 500);
    }
    try {
      delivery.id = await this.store.insert(delivery);
      this.metrics.created(delivery.channel!, phase);
      return delivery;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Duplicate') || msg.includes('ER_DUP_ENTRY')) {
        console.info(`Task notification delivery already exists: eventKey=${eventKey}`);
        return null;
      }
      throw e;
    }
  }

  async resolveWebSocket(delivery: TaskNotificationDelivery | null, delivered: boolean): Promise<void> {
    if (delivery == null || delivery.id == null) {
      return;
    }
    const nextStatus = delivered ? DeliveryStatus.SUPPRESSED_WS : DeliveryStatus.PENDING;
    const patch: Partial<TaskNotificationDelivery> = {
      status: nextStatus,
      nextRetryAt: delivered ? null : formatDateTime(new Date()),
    };
    const updated = this.store.updateIfStatus
      ? await this.store.updateIfStatus(delivery.id, DeliveryStatus.WAITING_WS, patch)
      : (await this.store.updateById({ id: delivery.id, ...patch }), true);
    if (updated && delivered) {
      this.metrics.suppressedByWebSocket(delivery.channel!);
    }
  }

  private normalizeTitle(title: string | null | undefined): string {
    const value = !hasText(title) ? '未命名任务' : title!.trim();
    return value.length <= 255 ? value : value.slice(0, 255);
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
  }
}
