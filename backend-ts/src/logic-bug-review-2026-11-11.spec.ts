/**
 * 2026-11-11 逻辑 BUG 审查——BUG-1 回归用例
 * （详见 docs/code-review/2026-11-11-logic-bug-review-01.md）。
 *
 * 原为 it.fails 存在性证明；`legacyMode: false` 落地后已转正为常规断言。
 * 另保留单方受限 expression 的回归，防止 AND 语义误伤常见的
 * `0 0 10 ? * MON-FRI` 形态。
 *
 * 原 BUG-5（channelAssistantReply 空正文不回落兜底）经复核回退：既有
 * citation-markers.spec.ts 已固化「content 为 null → 空串」契约，改兜底属产品取舍，
 * 不按 logic bug 修复；对应存在性用例已移除。
 */
import { describe, expect, it } from 'vitest';
import { buildCronPreview } from './schedule/scheduled-task.service.js';

// ---------------------------------------------------------------------------
// BUG-1（高）DOM+DOW 受限的 Spring cron 按 legacyMode 的 OR 语义触发
// 位置：backend-ts/src/schedule/scheduled-task.service.ts 全部 5 处
//       `new Cron(..., { ...CRON_OPTIONS })`；CRON_OPTIONS 含 timezone + legacyMode: false
// 契约：产品接受的 cron 方言是 Spring/Quartz（normalizeSpringCron 专门把 Spring 的
//       `?` 归一成 croner 的 `*`）。Spring 语义下 DOM 与 DOW **同时受限**时取交集
//       （两者都要满足）；croner 默认 legacyMode=true 是 POSIX 的 OR 语义
//       （任一命中即触发）。
// 实测（node 直探）：'0 0 12 1 1 1'（1 月 1 日且周一，Spring 下上次触发是
//       2024-01-01、下次是 2029-01-01）在修复前 nextRuns 从 2027-01-01（周五）
//       开始、并把 2027 年 1 月的每个周一全部列出——每周都会跑，与用户意图（四年
//       一次）严重偏离。
// 修复：5 处 Cron 构造统一使用 CRON_OPTIONS（legacyMode: false，croner 的 Quartz 语义）。
// ---------------------------------------------------------------------------
describe('BUG-1: DOM+DOW 受限的 Spring cron 按 OR 语义触发（应为 AND）', () => {
  it('0 0 12 1 1 1 的每次触发都必须是「1 月 1 日且周一」', () => {
    const preview = buildCronPreview('0 0 12 1 1 1', 5);
    expect(preview.valid).toBe(true);
    expect(preview.nextFireTimes.length).toBeGreaterThan(0);
    for (const fireTime of preview.nextFireTimes) {
      // AND 语义下每次触发同时满足：日期为 01-01，且星期一
      expect(fireTime.slice(5, 10), `触发点 ${fireTime} 不是 1 月 1 日`).toBe('01-01');
      const [y, m, d] = fireTime.split(' ')[0]!.split('-').map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      expect(dow, `触发点 ${fireTime} 不是周一（POSIX OR 语义把每个周一都排进来了）`).toBe(1);
    }
  });

  it('单方受限的 ? * MON-FRI 仍按周一至周五触发（AND 不误伤通配字段）', () => {
    const preview = buildCronPreview('0 0 10 ? * MON-FRI', 5);
    expect(preview.valid).toBe(true);
    expect(preview.nextFireTimes).toHaveLength(5);
    for (const fireTime of preview.nextFireTimes) {
      const [y, m, d] = fireTime.split(' ')[0]!.split('-').map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      expect(dow, `触发点 ${fireTime} 落在周末`).toBeGreaterThanOrEqual(1);
      expect(dow, `触发点 ${fireTime} 落在周末`).toBeLessThanOrEqual(5);
    }
  });
});
