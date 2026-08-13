import { formatDateTime } from '../../common/json.js';
import { hasText } from '../../common/case.js';
import type { Db } from '../../db/db.js';
import { DeliveryStatus, parseNotificationChannel, type TaskNotificationDelivery } from './types.js';
import type { WebhookSecretCipher } from './webhook-secret-cipher.js';
import type { WebhookSenderRegistry } from './webhook-sender.js';
import { webhookFailure } from './types.js';
import type { TaskNotificationMetrics } from './delivery.service.js';
import { InMemoryTaskNotificationMetrics } from './delivery.service.js';

export interface DeliverySchedulerStore {
  recoverInterrupted(cutoff: string, now: string): Promise<void>;
  listDue(now: string, limit: number): Promise<TaskNotificationDelivery[]>;
  claim(id: number, expectedStatus: string): Promise<boolean>;
  countPending(): Promise<number>;
  updateById(row: Partial<TaskNotificationDelivery> & { id: number }): Promise<void>;
  deleteHistory(cutoff: string): Promise<void>;
}

export class DeliverySchedulerDbStore implements DeliverySchedulerStore {
  constructor(private readonly db: Db) {}

  async recoverInterrupted(cutoff: string, now: string): Promise<void> {
    await this.db.execute(
      `UPDATE task_notification_delivery SET status = ?, next_retry_at = ? WHERE status = ? AND updated_at < ?`,
      [DeliveryStatus.PENDING, now, DeliveryStatus.SENDING, cutoff],
    );
  }

  listDue(now: string, limit: number): Promise<TaskNotificationDelivery[]> {
    return this.db.query(
      `SELECT * FROM task_notification_delivery
       WHERE ((status = ? AND next_retry_at <= ?) OR (status = ? AND next_retry_at <= ?))
       ORDER BY id ASC LIMIT ?`,
      [DeliveryStatus.PENDING, now, DeliveryStatus.WAITING_WS, now, limit],
    );
  }

  async claim(id: number, expectedStatus: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE task_notification_delivery SET status = ? WHERE id = ? AND status = ?`,
      [DeliveryStatus.SENDING, id, expectedStatus],
    );
    return result.affectedRows === 1;
  }

  async countPending(): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM task_notification_delivery WHERE status IN (?, ?, ?)`,
      [DeliveryStatus.WAITING_WS, DeliveryStatus.PENDING, DeliveryStatus.SENDING],
    );
    return Number(row?.c ?? 0);
  }

  async updateById(row: Partial<TaskNotificationDelivery> & { id: number }): Promise<void> {
    await this.db.updateById('task_notification_delivery', row.id, row);
  }

  async deleteHistory(cutoff: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM task_notification_delivery WHERE status IN (?, ?, ?) AND created_at < ?`,
      [DeliveryStatus.SUCCEEDED, DeliveryStatus.FAILED, DeliveryStatus.SUPPRESSED_WS, cutoff],
    );
  }
}

export interface TaskNotificationProperties {
  workerDelayMs: number;
  batchSize: number;
  maxAttempts: number;
}

export class WebhookDeliveryScheduler {
  private recoveryCompleted = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: DeliverySchedulerStore,
    private readonly properties: TaskNotificationProperties,
    private readonly cipher: WebhookSecretCipher,
    private readonly senderRegistry: WebhookSenderRegistry,
    private readonly metrics: TaskNotificationMetrics = new InMemoryTaskNotificationMetrics(),
    private readonly execute: (fn: () => void) => void = (fn) => { void Promise.resolve().then(fn); },
  ) {}

  start(): void {
    const delay = Math.max(1000, this.properties.workerDelayMs);
    this.timer = setInterval(() => { void this.dispatchDueDeliveries(); }, delay);
    this.cleanupTimer = setInterval(() => { void this.cleanupHistory(); }, 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async recoverInterruptedDeliveries(): Promise<void> {
    const cutoff = formatDateTime(new Date(Date.now() - 5 * 60 * 1000));
    await this.store.recoverInterrupted(cutoff, formatDateTime(new Date()));
  }

  async dispatchDueDeliveries(): Promise<void> {
    if (!this.recoveryCompleted) {
      this.recoveryCompleted = true;
      await this.recoverInterruptedDeliveries();
    }
    const now = formatDateTime(new Date());
    const due = await this.store.listDue(now, Math.max(1, this.properties.batchSize));
    for (const delivery of due) {
      const claimed = await this.store.claim(delivery.id!, delivery.status!);
      if (claimed) {
        this.execute(() => { void this.deliver(delivery); });
      }
    }
    this.metrics.pending(await this.store.countPending());
  }

  async cleanupHistory(): Promise<void> {
    const cutoff = formatDateTime(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    await this.store.deleteHistory(cutoff);
  }

  private async deliver(delivery: TaskNotificationDelivery): Promise<void> {
    const attempt = (delivery.attemptCount ?? 0) + 1;
    let result;
    try {
      const channel = parseNotificationChannel(delivery.channel);
      const url = this.cipher.decrypt(delivery.webhookCiphertext!);
      result = await this.senderRegistry.get(channel).send(url, this.buildContent(delivery));
    } catch {
      result = webhookFailure(false, null, null, '通知配置不可用');
    }
    const update: Partial<TaskNotificationDelivery> & { id: number } = {
      id: delivery.id!,
      attemptCount: attempt,
      lastHttpStatus: result.httpStatus,
      lastProviderCode: this.truncate(result.providerCode, 64),
      lastError: this.truncate(result.error, 1000),
    };
    if (result.success) {
      update.status = DeliveryStatus.SUCCEEDED;
      update.sentAt = formatDateTime(new Date());
      update.nextRetryAt = null;
      this.metrics.sent(delivery.channel!, 'success');
    } else if (result.retryable && attempt < this.properties.maxAttempts) {
      update.status = DeliveryStatus.PENDING;
      update.nextRetryAt = formatDateTime(new Date(Date.now() + this.retryDelayMinutes(attempt) * 60_000));
      this.metrics.sent(delivery.channel!, 'retryable_failure');
      this.metrics.retried(delivery.channel!);
    } else {
      update.status = DeliveryStatus.FAILED;
      update.nextRetryAt = null;
      this.metrics.sent(delivery.channel!, 'failed');
    }
    await this.store.updateById(update);
  }

  private buildContent(delivery: TaskNotificationDelivery): string {
    const result = delivery.terminalPhase === 'COMPLETED' ? '已完成' : '执行失败';
    let content = `Mao Agent 任务通知\n任务：${delivery.titleSnapshot}\n结果：${result}\n时间：${formatDateTime(new Date())}`;
    if (delivery.terminalPhase === 'FAILED' && hasText(delivery.failureReason)) {
      content += `\n原因：${delivery.failureReason}`;
    }
    return content;
  }

  private retryDelayMinutes(attempt: number): number {
    if (attempt === 1) return 1;
    if (attempt === 2) return 5;
    return 15;
  }

  private truncate(value: string | null | undefined, maxLength: number): string | null {
    if (value == null) return null;
    return value.length <= maxLength ? value : value.slice(0, maxLength);
  }
}
