/**
 * 进程内固定窗口限流（技术方案 §5.7）：key → { windowStart, count }。
 * 防滥用而非精确计量——重启清零可接受；多实例部署下各实例独立计数。
 * 实现为纯类便于单测（时钟可注入）。
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** 窗口剩余秒数（429 时写 Retry-After 头；允许时为 0）。 */
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 消费一个配额名额。窗口未超限返回 allowed=true；超限返回 false 并带窗口剩余秒数
   * （向上取整，保证 Retry-After >= 1）。
   */
  allow(key: string, limit: number): RateLimitDecision {
    if (limit <= 0) {
      return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
    }
    const now = this.now();
    const existing = this.windows.get(key);
    if (existing == null || now - existing.windowStart >= this.windowMs) {
      this.windows.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.windowStart + this.windowMs - now) / 1000)) };
  }

  /** 窗口表清理（防长驻进程 key 无限累积）；测试亦可用来复位。 */
  cleanup(now: number = this.now()): void {
    for (const [key, window] of this.windows) {
      if (now - window.windowStart >= this.windowMs * 2) {
        this.windows.delete(key);
      }
    }
  }
}
