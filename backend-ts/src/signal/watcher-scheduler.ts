import { formatDateTime } from '../common/json.js';
import type { MysqlSignalWatcherRepository } from './signal.repository.js';

/**
 * 信号哨兵轮询调度（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.3）。
 *
 * 结构对齐 `openapi/outbound-delivery.scheduler.ts`：setTimeout 链 + `dispatching`
 * 防重入 + `stopped` 标志 + `execute` 注入（装配层线程池 / 测试同步 runner）。
 * 差异点：哨兵无 claim 列，单飞用进程内 Set 标记；到期判定完全落在
 * `last_checked_at` 列上，进程重启后无需恢复内存态。
 */

/** 到期扫描间隔。 */
export const SCAN_INTERVAL_MS = 30_000;
/** 单轮扫描批量。 */
export const BATCH_SIZE = 50;

export interface WatcherSchedulerDeps {
  watcherRepo: MysqlSignalWatcherRepository;
  /** 单次轮询执行（WatcherService.runCheck；内部自行吞掉异常）。 */
  runCheck: (watcherId: number) => Promise<void>;
  /** 探针执行器注入（装配层线程池；测试注入同步 runner）。 */
  execute?: (fn: () => void | Promise<void>) => void;
  /** 扫描间隔 ms。 */
  intervalMs?: number;
}

export class WatcherScheduler {
  private readonly execute: (fn: () => void | Promise<void>) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispatching = false;
  private stopped = true;
  /** 在途 watcherId 单飞标记：调度重叠不叠加。 */
  private readonly inFlight = new Set<number>();

  constructor(private readonly deps: WatcherSchedulerDeps) {
    this.execute = deps.execute ?? ((fn) => { void Promise.resolve().then(fn); });
    this.intervalMs = deps.intervalMs ?? SCAN_INTERVAL_MS;
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

  /** 当前在途探针数（测试断言单飞用）。 */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatchDueWatchers()
        .catch((e) => console.error('信号哨兵调度异常', e))
        .finally(() => this.scheduleNext());
    }, this.intervalMs);
  }

  async dispatchDueWatchers(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const due = await this.deps.watcherRepo.listDue(formatDateTime(new Date()), BATCH_SIZE);
      for (const watcher of due) {
        if (watcher.id == null) continue;
        if (this.inFlight.has(watcher.id)) continue; // 单飞：重叠不叠加
        this.inFlight.add(watcher.id);
        this.execute(() => this.checkWatcher(watcher.id!));
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async checkWatcher(watcherId: number): Promise<void> {
    try {
      await this.deps.runCheck(watcherId);
    } catch (e) {
      console.error(`信号哨兵轮询异常, id=${watcherId}`, e);
    } finally {
      this.inFlight.delete(watcherId);
    }
  }
}
