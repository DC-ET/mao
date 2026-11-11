/**
 * 2026-11-11 逻辑 BUG 审查——存在性证明用例（详见 docs/code-review/2026-11-11-logic-bug-review-01.md）。
 *
 * 本文件以「存在性证明」形态落地：用例断言正确契约、当前实现必然失败，以 it.fails
 * 固化（expected-failure 通过，CI 保持绿色）；把 bugIt 改成 it 再跑即得各 BUG 的真实失败输出。
 * 对应 BUG 修复后转正为常规断言（与 2026-11-07 spec 的生命周期同款）。
 */
import { describe, expect, it } from 'vitest';
import { buildCronPreview } from './schedule/scheduled-task.service.js';
import { channelAssistantReply } from './session/util/citation-markers.js';

const bugIt = it.fails; // 存在性证明：当前实现必失败（expected-failure 保持 CI 绿）；修复后转 it

// ---------------------------------------------------------------------------
// BUG-1（高）DOM+DOW 受限的 Spring cron 按legacyMode 的 OR 语义触发
// 位置：backend-ts/src/schedule/scheduled-task.service.ts 全部 5 处
//       `new Cron(normalizeSpringCron(...), { timezone: 'Asia/Shanghai' })`
// 契约：产品接受的 cron 方言是 Spring/Quartz（normalizeSpringCron 专门把 Spring 的
//       `?` 归一成 croner 的 `*`）。Spring 语义下 DOM 与 DOW **同时受限**时取交集
//       （两者都要满足）；croner 默认 legacyMode=true 是 POSIX 的 OR 语义
//       （任一命中即触发）。
// 实测（node 直探）：'0 0 12 1 1 1'（1 月 1 日且周一，Spring 下上次触发是
//       2024-01-01、下次是 2029-01-01）在当前实现下 nextRuns 从 2027-01-01（周五）
//       开始、并把 2027 年 1 月的每个周一全部列出——每周都会跑，与用户意图（四年
//       一次）严重偏离。
// 修复方向：5 处 Cron 构造统一加 `legacyMode: false`（croner 的 Quartz 语义开关）。
// ---------------------------------------------------------------------------
describe('BUG-1: DOM+DOW 受限的 Spring cron 按 OR 语义触发（应为 AND）', () => {
  bugIt('0 0 12 1 1 1 的每次触发都必须是「1 月 1 日且周一」', () => {
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
});

// ---------------------------------------------------------------------------
// BUG-5（中）channelAssistantReply 对空正文 ASSISTANT 返回 ''，「无回复兜底文案」永不生效
// 位置：backend-ts/src/session/util/citation-markers.ts channelAssistantReply
// 契约（函数 docstring）：「取最后一条 ASSISTANT 正文并剥离 [^n^] 标记……语义（含无回复时的
//       兜底文案）单点收敛」——fallback 的语义域是「无可用回复正文」，包括正文为空 /
//       纯空白 / 剥掉标记与定义行后只剩空白的情况。
// 实际：只要存在 ASSISTANT 行就直接 `stripCitationMarkers(content ?? '')` 返回，
//       空串 / 空白 / 剥后空白全部原样返回，fallback 只在「一条 ASSISTANT 都没有」时才触发。
// 下游三处行为因此分叉（全部真实代码路径）：
//   ① scheduled-task 微信/飞书回流：`if (!reply || reply.trim() === '') return;` → 静默不发，
//      用户对「定时任务跑了但什么都没收到」零感知，兜底文案形同虚设；
//   ② 飞书完成卡：cardListener.complete('') → 终态卡正文为空白；
//   ③ 飞书降级 plain reply：空串被守卫拦下、纯空白 `'   '` 却能穿过 `!== ''` 守卫发成空白消息。
// 修复方向：剥离标记后 trim 为空 → 返回 fallback；同时不回落更早一条 ASSISTANT 的旧正文
//       （终态归属本轮，feishu agent-inbound-handler 注释同口径）。
// ---------------------------------------------------------------------------
describe('BUG-5: channelAssistantReply 空正文不回落兜底文案', () => {
  const FALLBACK = '抱歉，暂时无法生成回复。';

  bugIt('ASSISTANT 正文为空 / 纯空白 / 剥标记后只剩空白时必须返回兜底文案', () => {
    expect(channelAssistantReply([{ role: 'ASSISTANT', content: '' }], FALLBACK)).toBe(FALLBACK);
    expect(channelAssistantReply([{ role: 'ASSISTANT', content: '   ' }], FALLBACK)).toBe(FALLBACK);
    expect(channelAssistantReply([{ role: 'ASSISTANT', content: null }], FALLBACK)).toBe(FALLBACK);
    // 全文只有标记与定义行：剥离后无可读正文，同样属「无可用回复」
    expect(
      channelAssistantReply([{ role: 'ASSISTANT', content: '[^1^]\n[^1^]: https://example.com' }], FALLBACK),
    ).toBe(FALLBACK);
  });

  bugIt('最后一条 ASSISTANT 为空时也不得回落更早一条的旧正文', () => {
    const reply = channelAssistantReply(
      [{ role: 'ASSISTANT', content: '上一轮的旧回复' }, { role: 'ASSISTANT', content: '' }],
      FALLBACK,
    );
    expect(reply).toBe(FALLBACK);
  });
});
