import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const result = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 9 }, (_, i) => i), 2, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      return undefined;
    });
    expect(peak).toBe(2);
  });

  it('handles empty input and limit greater than size', async () => {
    expect(await mapWithConcurrency([], 4, async (n: number) => n)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });

  it('propagates the first error and stops dispatching new items', async () => {
    const started: number[] = [];
    await expect(mapWithConcurrency(Array.from({ length: 9 }, (_, i) => i), 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 1));
      if (n === 0) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
    // 首个错误后不再领取新任务：最多 2 个（两个 worker 各领一个）
    expect(started.length).toBeLessThanOrEqual(2);
  });
});
