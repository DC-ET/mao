import { describe, expect, it } from 'vitest';
import { WsRateLimiter } from './ws-rate-limiter.js';

describe('WsRateLimiter', () => {
  it('burstAllowsUpToCapacityThenRejects', () => {
    const limiter = new WsRateLimiter(6, 12);
    let t = 1_000_000;
    for (let i = 0; i < 12; i++) {
      expect(limiter.allow('s1', t)).toBe(true);
    }
    expect(limiter.allow('s1', t)).toBe(false);
  });

  it('refillsProportionallyToElapsedTime', () => {
    const limiter = new WsRateLimiter(6, 12);
    let t = 1_000_000;
    for (let i = 0; i < 12; i++) limiter.allow('s1', t);
    expect(limiter.allow('s1', t)).toBe(false);
    t += 250; // 6/s → 补 1.5 个令牌：够放行一次，第二次不够
    expect(limiter.allow('s1', t)).toBe(true);
    expect(limiter.allow('s1', t)).toBe(false);
  });

  it('idleKeyRecoversFullBurst', () => {
    const limiter = new WsRateLimiter(6, 12);
    let t = 1_000_000;
    for (let i = 0; i < 12; i++) limiter.allow('s1', t);
    t += 60_000; // 空闲 1 分钟：远超 burst 补满所需
    for (let i = 0; i < 12; i++) {
      expect(limiter.allow('s1', t)).toBe(true);
    }
    expect(limiter.allow('s1', t)).toBe(false);
  });

  it('tracksKeysIndependentlyAndClearRemovesKey', () => {
    const limiter = new WsRateLimiter(1, 1);
    const t = 1_000_000;
    expect(limiter.allow('a', t)).toBe(true);
    expect(limiter.allow('a', t)).toBe(false);
    expect(limiter.allow('b', t)).toBe(true);
    limiter.clear('a');
    expect(limiter.allow('a', t)).toBe(true);
    limiter.clearAll();
    expect(limiter.allow('b', t)).toBe(true);
  });
});
