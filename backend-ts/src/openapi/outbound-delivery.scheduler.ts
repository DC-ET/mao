import { formatDateTime } from '../common/json.js';
import type { WebhookSecretCipher } from '../notification/task/webhook-secret-cipher.js';
import type { MysqlOutboundDeliveryRepository, MysqlOutboundSubscriptionRepository } from './openapi.repository.js';
import { hmacSignature } from './hmac.js';
import type { GenericHttpWebhookSender } from './generic-webhook-sender.js';
import { isOutboundEvent, type OutboundEvent } from './types.js';

/** 重试退避（分钟）：1 / 5 / 25，共 3 次重试后终态 FAILED（技术方案 §5.5）。 */
const RETRY_DELAY_MINUTES = [1, 5, 25];
/** 单轮扫描批量。 */
const BATCH_SIZE = 50;
/** SENDING 卡死行恢复的执行间隔：每 tick 一次代价过高，节流为每分钟。 */
const RECOVERY_INTERVAL_MS = 60_000;

/** 终态 FAILED 落审计（技术方案 §5.5），create-app 装配层适配 AuditLogService。 */
export interface OutboundDeliveryAuditRecorder {
  recordDeliveryFailed(input: { subscriptionId: number; event: string; targetUrl: string; userId: number | null; error: string | null }): Promise<void>;
}

export interface OutboundDeliverySchedulerDeps {
  deliveryRepo: MysqlOutboundDeliveryRepository;
  subscriptionRepo: MysqlOutboundSubscriptionRepository;
  cipher: WebhookSecretCipher;
  sender: GenericHttpWebhookSender;
  auditRecorder?: OutboundDeliveryAuditRecorder | null;
  /** 投递执行器（装配层注入线程池；测试注入同步 runner）。 */
  execute?: (fn: () => void | Promise<void>) => void;
  /** 轮询间隔 ms。 */
  intervalMs?: number;
}

/**
 * 出站投递重试调度（对齐 notification/task/delivery.scheduler.ts 的重试模型）：
 * setTimeout 链周期扫描 PENDING 行 → CAS 认领 → 线程池投递 → 终态回写。
 */
export class OutboundDeliveryScheduler {
  private readonly execute: (fn: () => void | Promise<void>) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispatching = false;
  private lastRecoveryAt = 0;
  private stopped = true;

  constructor(private readonly deps: OutboundDeliverySchedulerDeps) {
    this.execute = deps.execute ?? ((fn) => { void Promise.resolve().then(fn); });
    this.intervalMs = deps.intervalMs ?? 5_000;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatchDueDeliveries()
        .catch((e) => console.error('出站投递调度异常', e))
        .finally(() => this.scheduleNext());
    }, this.intervalMs);
  }

  async dispatchDueDeliveries(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const nowMs = Date.now();
      if (nowMs - this.lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
        this.lastRecoveryAt = nowMs;
        const cutoff = formatDateTime(new Date(nowMs - 5 * 60 * 1000));
        await this.deps.deliveryRepo.recoverInterrupted(cutoff, formatDateTime(new Date()));
      }
      const now = formatDateTime(new Date());
      const due = await this.deps.deliveryRepo.listDue(now, BATCH_SIZE);
      for (const delivery of due) {
        if (delivery.id == null) continue;
        const claimed = await this.deps.deliveryRepo.claim(delivery.id);
        if (claimed) {
          this.execute(() => this.deliver(delivery.id!));
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async deliver(deliveryId: number): Promise<void> {
    try {
      // 发送前重查投递行与订阅（行可能在排队期间被删/订阅停用）
      const row = await this.deps.deliveryRepo.findById(deliveryId);
      if (row == null || row.subscriptionId == null) return;
      const subscription = await this.deps.subscriptionRepo.findById(row.subscriptionId);
      if (subscription == null || Number(subscription.enabled) !== 1 || subscription.secretCipher == null) {
        await this.deps.deliveryRepo.markFailed(deliveryId, Number(row.attemptCount ?? 0) + 1, null, '订阅不存在或已停用');
        return;
      }
      const event = row.event;
      if (!isOutboundEvent(event)) {
        await this.deps.deliveryRepo.markFailed(deliveryId, Number(row.attemptCount ?? 0) + 1, null, '未知事件类型');
        return;
      }
      const attempt = Number(row.attemptCount ?? 0) + 1;
      const secret = this.deps.cipher.decrypt(subscription.secretCipher);
      const payload = this.safeParse(row.payload);
      const result = await this.deps.sender.send(subscription.targetUrl ?? '', secret, event, payload, hmacSignature);
      if (result.success) {
        await this.deps.deliveryRepo.markSucceeded(deliveryId, attempt, result.httpStatus, formatDateTime(new Date()));
        return;
      }
      const retryIndex = attempt - 1;
      if (result.retryable && retryIndex < RETRY_DELAY_MINUTES.length) {
        const nextRetryAt = formatDateTime(new Date(Date.now() + RETRY_DELAY_MINUTES[retryIndex] * 60_000));
        await this.deps.deliveryRepo.scheduleRetry(deliveryId, attempt, result.httpStatus, result.error, nextRetryAt);
        return;
      }
      await this.deps.deliveryRepo.markFailed(deliveryId, attempt, result.httpStatus, result.error);
      await this.recordFailedAudit(subscription.userId ?? null, subscription.id ?? null, event, subscription.targetUrl ?? null, result.error);
    } catch (e) {
      console.error(`出站投递发送异常, id=${deliveryId}`, e);
    }
  }

  private async recordFailedAudit(userId: number | null, subscriptionId: number | null, event: OutboundEvent, targetUrl: string | null, error: string | null): Promise<void> {
    try {
      await this.deps.auditRecorder?.recordDeliveryFailed({
        subscriptionId: subscriptionId ?? 0,
        event,
        targetUrl: targetUrl ?? '',
        userId,
        error,
      });
    } catch (e) {
      console.warn(`[outbound] failed to record delivery failed audit: ${(e as Error).message}`);
    }
  }

  private safeParse(payload: string | null | undefined): Record<string, unknown> {
    try {
      const parsed = payload == null ? {} : JSON.parse(payload);
      return typeof parsed === 'object' && parsed != null ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
}
