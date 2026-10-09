import { formatDateTime } from '../common/json.js';

/** 保留天数：90 天为代码常量，对齐收件箱。 */
const RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface ScheduledTaskRunCleanupStore {
  deleteRunsBefore(cutoff: string): Promise<void>;
}

/** 运行记录只存摘要，到期硬删。 */
export class ScheduledTaskRunCleanupScheduler {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly store: ScheduledTaskRunCleanupStore) {}

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
      await this.store.deleteRunsBefore(cutoff);
    } catch (e) {
      console.error('定时任务运行记录清理异常', e);
    }
  }
}
