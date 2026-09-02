import { formatDateTime } from '../../common/json.js';
import { hasText, toSnakeRow } from '../../common/case.js';
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
  /** 按 id 读取（deliver 发送前重查状态用，可选）。 */
  findById?(id: number): Promise<TaskNotificationDelivery | null>;
  /** 终态回写带状态 CAS（WHERE id=? AND status=?，可选；未提供时 deliver 走 updateById 旧行为）。 */
  updateIfStatus?(id: number, expectedStatus: string, row: Partial<TaskNotificationDelivery>): Promise<boolean>;
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

  findById(id: number): Promise<TaskNotificationDelivery | null> {
    return this.db.queryOne('SELECT * FROM task_notification_delivery WHERE id = ?', [id]);
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

  async updateIfStatus(id: number, expectedStatus: string, row: Partial<TaskNotificationDelivery>): Promise<boolean> {
    const data = toSnakeRow(row as Record<string, unknown>);
    delete data.id;
    const entries = Object.entries(data);
    if (entries.length === 0) return false;
    const setSql = entries.map(([c]) => `\`${c}\` = ?`).join(', ');
    const result = await this.db.execute(
      `UPDATE task_notification_delivery SET ${setSql} WHERE id = ? AND status = ?`,
      [...entries.map(([, v]) => v), id, expectedStatus],
    );
    return result.affectedRows === 1;
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

/** 调度参数来源：静态对象（默认值/测试）或动态 getter（后台配置，保存后即时生效）。 */
export type TaskNotificationPropertiesSource = TaskNotificationProperties | (() => Promise<TaskNotificationProperties>);

/** SENDING 卡死行恢复的执行间隔：每 tick 一次代价过高，节流为每分钟。 */
const RECOVERY_INTERVAL_MS = 60_000;

export class WebhookDeliveryScheduler {
  private lastRecoveryAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly store: DeliverySchedulerStore,
    private readonly propertiesSource: TaskNotificationPropertiesSource,
    private readonly cipher: WebhookSecretCipher,
    private readonly senderRegistry: WebhookSenderRegistry,
    private readonly metrics: TaskNotificationMetrics = new InMemoryTaskNotificationMetrics(),
    private readonly execute: (fn: () => void) => void = (fn) => { void Promise.resolve().then(fn); },
  ) {}

  private async resolveProperties(): Promise<TaskNotificationProperties> {
    const source = this.propertiesSource;
    return typeof source === 'function' ? await source() : source;
  }

  start(): void {
    this.stopped = false;
    this.cleanupTimer = setInterval(() => { void this.cleanupHistory(); }, 60 * 60 * 1000);
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** setTimeout 链轮询：每轮重新读取 workerDelayMs，后台改轮询间隔无需重启。 */
  private scheduleNext(): void {
    void this.resolveProperties()
      .then((p) => {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.dispatchDueDeliveries().finally(() => this.scheduleNext());
        }, Math.max(1000, p.workerDelayMs));
      })
      .catch((e) => console.error('任务通知调度参数读取失败，1 分钟后重试', e));
  }

  async recoverInterruptedDeliveries(): Promise<void> {
    const cutoff = formatDateTime(new Date(Date.now() - 5 * 60 * 1000));
    await this.store.recoverInterrupted(cutoff, formatDateTime(new Date()));
  }

  async dispatchDueDeliveries(): Promise<void> {
    try {
      // 恢复逻辑周期化执行（原先仅进程首个 tick 一次）：卡死在 SENDING 的行可在运行期被复位，
      // 不必等到进程重启。updated_at 带 ON UPDATE CURRENT_TIMESTAMP，5 分钟 cutoff 不会误伤在途发送。
      const nowMs = Date.now();
      if (nowMs - this.lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
        this.lastRecoveryAt = nowMs;
        await this.recoverInterruptedDeliveries();
      }
      const now = formatDateTime(new Date());
      const properties = await this.resolveProperties();
      const due = await this.store.listDue(now, Math.max(1, properties.batchSize));
      for (const delivery of due) {
        const claimed = await this.store.claim(delivery.id!, delivery.status!);
        if (claimed) {
          this.execute(() => { void this.deliver(delivery); });
        }
      }
      this.metrics.pending(await this.store.countPending());
    } catch (e) {
      console.error('任务通知投递调度异常', e);
    }
  }

  async cleanupHistory(): Promise<void> {
    try {
      const cutoff = formatDateTime(new Date(Date.now() - 90 * 24 * 3600 * 1000));
      await this.store.deleteHistory(cutoff);
    } catch (e) {
      console.error('任务通知历史清理异常', e);
    }
  }

  private async deliver(delivery: TaskNotificationDelivery): Promise<void> {
    try {
      // WS 结果晚到的竞态兜底：resolveWebSocket 可能已把该行从 SENDING 抑制为 SUPPRESSED_WS，
      // 此时 webhook 不应再发，否则用户会收到「WS + webhook」重复通知。
      if (this.store.findById) {
        const latest = await this.store.findById(delivery.id!);
        if (latest?.status === DeliveryStatus.SUPPRESSED_WS) {
          this.metrics.sent(delivery.channel!, 'suppressed_by_ws');
          return;
        }
      }
      const properties = await this.resolveProperties();
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
      } else if (result.retryable && attempt < properties.maxAttempts) {
        update.status = DeliveryStatus.PENDING;
        update.nextRetryAt = formatDateTime(new Date(Date.now() + this.retryDelayMinutes(attempt) * 60_000));
        this.metrics.sent(delivery.channel!, 'retryable_failure');
        this.metrics.retried(delivery.channel!);
      } else {
        update.status = DeliveryStatus.FAILED;
        update.nextRetryAt = null;
        this.metrics.sent(delivery.channel!, 'failed');
      }
      if (this.store.updateIfStatus) {
        // 终态回写走状态 CAS（SENDING）：webhook 发送期间 resolveWebSocket 可能已把该行
        // 抑制为 SUPPRESSED_WS，无条件 updateById 会把抑制态覆盖回 PENDING/SUCCEEDED，
        // 造成 webhook 与 WS 重复通知。
        const casOk = await this.store.updateIfStatus(delivery.id!, DeliveryStatus.SENDING, update);
        if (!casOk) {
          console.info(`任务通知终态回写 CAS 失败（发送期间已被 WS 抑制），放弃覆盖, id=${delivery.id}, intended=${update.status}`);
        }
        return;
      }
      await this.store.updateById(update);
    } catch (e) {
      console.error(`任务通知发送异常, id=${delivery.id}`, e);
    }
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
