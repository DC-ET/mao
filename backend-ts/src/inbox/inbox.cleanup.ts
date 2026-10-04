import { formatDateTime } from '../common/json.js';

/** 保留天数：90 天为代码常量（不做系统设置化，KISS）。 */
const RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface InboxCleanupStore {
  deleteHistory(cutoff: string): Promise<void>;
}

/**
 * 收件箱历史清理调度器：对齐 `WebhookDeliveryScheduler` 的 start/stop + cleanupTimer 结构
 * （notification/task/delivery.scheduler.ts），每小时一次执行删除。
 *
 * 刻意不对齐 `RuntimeCleanupScheduler`：后者是文件系统扫描器，不碰 DB、无「每日一次」概念。
 * 也刻意不照抄 deleteHistory 的 status 条件与分批：收件箱量级远小于 task_notification_delivery，
 * 90 天前的已读/未读都是过期数据（不存在「未读必须永久保留」），单条 DELETE 即可。
 */
export class InboxCleanupScheduler {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly store: InboxCleanupStore) {}

  start(): void {
    this.stopped = false;
    this.cleanupTimer = setInterval(() => { void this.cleanupHistory(); }, CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async cleanupHistory(): Promise<void> {
    if (this.stopped) return;
    try {
      const cutoff = formatDateTime(new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000));
      await this.store.deleteHistory(cutoff);
    } catch (e) {
      console.error('收件箱历史清理异常', e);
    }
  }
}
