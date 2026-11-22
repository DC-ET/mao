import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-22 逻辑 BUG 审查的存在性验证用例（对应 docs/code-review/2026-11/2026-11-22-logic-bug-review-01.md）。
 *
 * 惯例同 logic-bug-review-2026-11-13：用例按「正确契约」书写，在缺陷代码上真实失败即确认缺陷。
 * BUG-3 两个用例确认后当日修复（六处 slice → clipByCodePoints），已转正为普通 it 回归。
 * agent-loop 与 terminal-host 两处因复用域内测试 harness，用例分别落在
 * agent-loop.spec.ts / terminal-host-handler.spec.ts（同样已修复转正）。
 */
import { FeishuCardProgressListener } from './feishu/card-progress-listener.js';
import { progressCardParams } from './dingtalk/card-body.js';

/** 未修复缺陷的固化：it.fails = expected-failure（CI 绿），修复后转正为普通 it。 */
/** 内容末位是孤立代理（高代理后无低代理，或低代理前无高代理）时返回 true。 */
function endsWithLoneSurrogate(text: string): boolean {
  if (text.length === 0) return false;
  const units = Array.from(text).join('');
  // 与原串比对码元数：孤立代理经 Array.from 会并入 U+FFFD 或单独保留，长度守恒性不可靠，
  // 直接按码元扫描最稳：任一位置出现未配对代理即 true（这里只关心末位截断场景）。
  const codes = Array.from(text, (c) => c.codePointAt(0)!);
  const last = codes[codes.length - 1]!;
  return last >= 0xd800 && last <= 0xdfff;
}

// ────────────────────────────────────────────────────────────────────────────
// CARD-BUG-1 飞书进度卡正文/工具摘要截断按 UTF-16 码元硬切，恰在边界的 emoji
// 被切成孤立代理进入卡片 JSON（feishu/dingtalk 同类 slice 共 6 处）。
// 同仓库 weixin 侧已按正确口径修复过同缺陷类（weixin/send.service.ts
// prefixLenWithinBytes），通道卡片链路漏修。
// ────────────────────────────────────────────────────────────────────────────

describe('FeishuCardProgressListener.complete 卡片正文截断（CARD_TEXT_MAX=6000）', () => {
  it('截断点恰在 emoji 中间时不得产出孤立代理', async () => {
    const updates: Array<{ status: string; content: string }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (status, _round, content) => { updates.push({ status, content }); },
    });
    listener.onRoundStart(1);
    // 5999 个「中」+ 😀（2 码元）+ 后文：截断点（第 6000 码元）恰落在 😀 的两个代理中间
    const content = '中'.repeat(5999) + '😀' + '后续内容';
    expect(content.length).toBeGreaterThan(6000);
    await listener.complete(content);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const completed = updates.find((u) => u.status === 'COMPLETED');
    expect(completed).toBeDefined();
    expect(completed!.content.length).toBeLessThanOrEqual(6000);
    expect(endsWithLoneSurrogate(completed!.content)).toBe(false);
  });
});

describe('dingtalk progressCardParams 卡片正文截断（BODY_MAX=6000）', () => {
  it('截断点恰在 emoji 中间时 body 不得含孤立代理', () => {
    // 先探出状态行长度，再把 emoji 精确摆到第 6000 码元切点上（高代理在 5999、低代理被切掉）
    const probe = progressCardParams({ status: 'completed', round: 1, sessionId: 1, senderUserid: 'u1' });
    const prefixLen = probe.body.length + 2; // body = 状态行 + '\n\n' + detail
    const detail = '中'.repeat(6000 - prefixLen - 1) + '😀' + '后续内容';
    const params = progressCardParams({
      status: 'completed',
      round: 1,
      detail,
      sessionId: 1,
      senderUserid: 'u1',
    });
    expect(params.body.length).toBeLessThanOrEqual(6000);
    expect(params.body.length).toBeGreaterThan(5900);
    expect(endsWithLoneSurrogate(params.body)).toBe(false);
  });
});
