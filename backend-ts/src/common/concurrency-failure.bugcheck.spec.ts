import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

/**
 * Bugcheck：mapWithConcurrency（2026-10-22 fa3f47b1 新增）在 IM 入站图片压缩中的失败语义。
 *
 * 调用方：dingtalk/feishu/weixin 的 agent-inbound-handler 用
 *   mapWithConcurrency(media.images, 2, (uri) => PromptImageResizer.compressDataUriForStore(uri))
 * 组装 ContentPart。compressDataUriForStore 内部已 try-catch 并对失败/未变小原样返回，
 * 因此正常不会抛。
 *
 * 但 compressDataUriForStore 有一处不在 try 内：`Buffer.from(uri.slice(comma + 1), 'base64')`
 * 之前的 `uri.indexOf(',')` / `header.includes` 都在同步区，若 uri 是畸形 data URI
 * （例如 'data:image/png;base64' 无逗号）会走到 `comma < 0 → return uri` 分支，不抛。
 *
 * 真正要验证的是：万一 fn 抛错，整个入站消息组装是否会被打断、图片是否全丢。
 */

describe('mapWithConcurrency failure semantics', () => {
  it('stops dispatching new items after the first error', async () => {
    // 与官方 concurrency.spec.ts 同口径：两个 worker 各领一个后，首个错误不再派发新任务。
    // 注意：`next++` 发生在 `await fn(...)` 之前，因此「已领取但尚未 push」的项仍会被
    // 计入 processed——这里的上界按 worker 数 × (已领取) 计，不用同步抛错的严格口径。
    const processed: number[] = [];
    await expect(mapWithConcurrency(Array.from({ length: 9 }, (_, i) => i), 2, async (n) => {
      processed.push(n);
      await new Promise((r) => setTimeout(r, 1));
      if (n === 0) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
    expect(processed.length).toBeLessThanOrEqual(2);
  });

  it('a single failure aborts the whole batch (no partial results)', async () => {
    // 这是 IM 入站的关键风险点：一张图压缩失败 → 整条消息组装抛错
    const images = ['data:image/png;base64,AAA', 'bad-uri', 'data:image/png;base64,CCC'];
    let threw = false;
    try {
      await mapWithConcurrency(images, 2, async (uri, i) => {
        if (uri === 'bad-uri') throw new Error('invalid');
        return `${i}:${uri}`;
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('keeps results aligned with input indices on success', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 3, async (s, i) => `${i}-${s}`);
    expect(out).toEqual(['0-a', '1-b', '2-c']);
  });

  it('does not leak workers after completion', async () => {
    const running = { n: 0 };
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running.n += 1;
      await new Promise((r) => setTimeout(r, 1));
      running.n -= 1;
      return 0;
    });
    expect(running.n).toBe(0);
  });
});
