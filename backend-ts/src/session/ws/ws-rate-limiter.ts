/**
 * per-session 令牌桶限速（技术方案 2026-11-20 v2 D9）：browser-use 技能直播帧从 runner
 * 进入 /api/ws/stream，失控的 sidecar（或恶意客户端伪装 runner）不能用帧流量挤占会话流。
 * 令牌按时间连续补充（不按 tick），超限返回 false 由调用方丢弃并计数。
 */
export class WsRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {}

  /** 取走一个令牌；桶空则拒绝。key 一般为 sessionId 字符串。 */
  allow(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, last: now };
    const elapsed = Math.max(0, now - bucket.last);
    // 补充量与耗时成正比，封顶 burst；长期空闲的 key 恢复满桶
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsed / 1000) * this.ratePerSecond);
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  clearAll(): void {
    this.buckets.clear();
  }
}
