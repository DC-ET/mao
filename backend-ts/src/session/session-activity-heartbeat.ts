import type { SessionService } from './session.service.js';

const MIN_INTERVAL_MS = 30_000;

/**
 * Throttled heartbeat that refreshes session.last_activity_at during long-running agent work.
 *
 * `touch` 由 agent 循环按轮调用，只能覆盖"轮与轮之间"的活性。单个工具（如长命令、
 * 长 web 抓取）可能持续数分钟且期间不产生轮事件，此时 last_activity_at 会显得陈旧。
 * 因此执行期间额外用 `start`/`stop` 挂一个独立的定时心跳：只要执行还在，时间戳就持续
 * 刷新，"last_activity_at 陈旧" 才能真正等价于 "该执行已死"（孤儿会话巡检据此判定）。
 */
export class SessionActivityHeartbeat {
  private readonly lastTouchMs = new Map<number, number>();
  private readonly timers = new Map<number, { timer: NodeJS.Timeout; depth: number }>();

  constructor(private readonly sessionService: SessionService) {}

  touch(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    const now = Date.now();
    const last = this.lastTouchMs.get(sessionId);
    if (last != null && now - last < MIN_INTERVAL_MS) {
      return;
    }
    this.write(sessionId);
  }

  /** 执行开始：立即刷新一次，并挂上独立定时心跳（同一会话按引用计数，可重入）。 */
  start(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    const existing = this.timers.get(sessionId);
    if (existing != null) {
      existing.depth += 1;
      return;
    }
    const timer = setInterval(() => this.write(sessionId), MIN_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(sessionId, { timer, depth: 1 });
    this.write(sessionId);
  }

  /** 执行结束：引用计数归零后停掉定时心跳。 */
  stop(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    const entry = this.timers.get(sessionId);
    if (entry == null) return;
    entry.depth -= 1;
    if (entry.depth > 0) return;
    clearInterval(entry.timer);
    this.timers.delete(sessionId);
    this.lastTouchMs.delete(sessionId);
  }

  /** 进程退出前清理所有定时器。 */
  stopAll(): void {
    for (const entry of this.timers.values()) clearInterval(entry.timer);
    this.timers.clear();
    this.lastTouchMs.clear();
  }

  clear(sessionId: number | null | undefined): void {
    if (sessionId != null) {
      this.lastTouchMs.delete(sessionId);
    }
  }

  private write(sessionId: number): void {
    this.lastTouchMs.set(sessionId, Date.now());
    void this.sessionService.touchLastActivity(sessionId).catch((e) => {
      console.debug(`Failed to touch last_activity_at for session ${sessionId}: ${(e as Error).message}`);
    });
  }
}
