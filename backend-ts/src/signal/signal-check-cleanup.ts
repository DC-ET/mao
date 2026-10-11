import { formatDateTime } from '../common/json.js';
import type { MysqlSignalCheckRepository } from './signal.repository.js';

/**
 * 哨兵轮询记录滚动清理（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.7）。
 * 结构对齐 `openapi/open-api-call-log.cleanup.ts`：setInterval + stopped + 分批删除。
 */

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 5000;
const MAX_BATCHES = 20;
/** 保留天数缺省（设置项未配或非法时回落）。 */
const DEFAULT_RETENTION_DAYS = 90;

export class SignalCheckCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly repo: MysqlSignalCheckRepository,
    private readonly retentionDays: () => Promise<number>,
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanupOnce(now = Date.now()): Promise<number> {
    if (this.stopped) return 0;
    const days = await this.retentionDays();
    const safeDays = Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
    const cutoff = formatDateTime(now - safeDays * 24 * 60 * 60 * 1000);
    let removed = 0;
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const n = await this.repo.deleteBatch(cutoff, BATCH_LIMIT);
      removed += n;
      if (n < BATCH_LIMIT) break;
    }
    return removed;
  }
}
