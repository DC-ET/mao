import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './rate-limiter.js';

describe('FixedWindowRateLimiter（进程内固定窗口）', () => {
  it('窗口内计数到 limit 后 429，窗口滚动后恢复', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter(60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.allow('k', 3).allowed).toBe(true);
    }
    const blocked = limiter.allow('k', 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    now += 60_001;
    expect(limiter.allow('k', 3).allowed).toBe(true);
  });

  it('不同 key 相互独立', () => {
    let now = 2_000_000;
    const limiter = new FixedWindowRateLimiter(60_000, () => now);
    expect(limiter.allow('a', 1).allowed).toBe(true);
    expect(limiter.allow('b', 1).allowed).toBe(true);
    expect(limiter.allow('a', 1).allowed).toBe(false);
  });

  it('limit<=0 直接拒绝（兜底防御）', () => {
    const limiter = new FixedWindowRateLimiter(60_000, () => 0);
    expect(limiter.allow('k', 0).allowed).toBe(false);
  });
});
