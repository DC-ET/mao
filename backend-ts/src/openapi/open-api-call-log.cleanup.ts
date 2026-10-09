import { formatDateTime } from '../common/json.js';
import type { OpenApiCallLogRepository } from './open-api-call-log.repository.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 5000;
const MAX_BATCHES = 20;

export class OpenApiCallLogCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly repo: OpenApiCallLogRepository,
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
    const safeDays = Number.isInteger(days) && days > 0 ? days : 90;
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
