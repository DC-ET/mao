/**
 * 回归用例（第六轮逻辑 BUG 审查锚点转正，BUG-8）：
 * weixin/webhook-fallback.service.ts:85/:90 的降级推送截断曾用 `text.slice(0, N)` 按 UTF-16
 * 码元硬切。MAX_FALLBACK_TEXT_CHARS=4000 / MAX_FALLBACK_CARD_CHARS=3000 语义是「字符数」，
 * 但码元切点落在代理对中间时会留下孤立代理，随 payload JSON 发往钉钉/飞书 webhook，
 * 对端渲染成 U+FFFD 乱码（极端情况被拒收）。同族问题 2026-11-22 第五轮已用
 * common/utf8.ts 的 clipByCodePoints 修过 6 处，本路径是漏网的同类点，已修复。
 *
 * 本用例断言「正确行为」：推送到 webhook 的 text / card 不得含孤立代理。
 * 对照组：同库 clipByCodePoints 对同样输入无孤立代理，证明修复手段现成。
 */
import { describe, expect, it, vi } from 'vitest';

import { WeixinWebhookFallbackService } from './webhook-fallback.service.js';
import { clipByCodePoints } from '../common/utf8.js';

/** 文本中是否存在孤立代理（高位代理后未跟低位代理，或裸低位代理）。 */
function loneSurrogate(text: string): { index: number; code: string } | null {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { index: i, code: c.toString(16) };
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return { index: i, code: c.toString(16) };
    }
  }
  return null;
}

/** 前面垫一个 ASCII，让 4000/3000 码元切点正好落在某个 emoji 的代理对中间。 */
const LONG_TEXT = `报告标题\n${'🎉'.repeat(2000)}\n`;

function makeService() {
  const sent: Array<{ text: string; card: unknown }> = [];
  const service = new WeixinWebhookFallbackService(
    { findEnabled: vi.fn(async () => ({ channel: 'DINGTALK', webhookCiphertext: 'cipher' })) },
    { decrypt: () => 'https://oapi.dingtalk.com/robot/send?access_token=x' },
    {
      get: () => ({
        send: vi.fn(async (_url: string, payload: { text: string; card: unknown }) => {
          sent.push({ text: payload.text, card: payload.card });
          return { success: true };
        }),
      }),
    } as never,
  );
  return { service, sent };
}

describe('微信 webhook 降级推送截断的代理对完整性（回归）', () => {
  it('推送正文切在 emoji 中间时不得留下孤立代理', async () => {
    const { service, sent } = makeService();
    await service.sendFallback(1, LONG_TEXT);
    expect(sent).toHaveLength(1);
    expect(loneSurrogate(sent[0].text)).toBeNull();
  });

  it('飞书卡片正文切在 emoji 中间时不得留下孤立代理', async () => {
    const { service, sent } = makeService();
    await service.sendFallback(1, LONG_TEXT);
    // 直接遍历卡片里的字符串：JSON.stringify 会把孤立代理转义成 \udXXX 字面量，
    // 从序列化结果里反而检测不到，必须看序列化前的原始值。
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node != null && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(sent[0].card);
    const bad = strings.filter((s) => loneSurrogate(s) != null);
    expect(bad).toHaveLength(0);
  });

  it('对照组：同库 clipByCodePoints 对同样输入无孤立代理（修复手段现成）', () => {
    expect(loneSurrogate(clipByCodePoints(LONG_TEXT, 4000))).toBeNull();
    expect(loneSurrogate(clipByCodePoints(LONG_TEXT, 3000))).toBeNull();
  });

  it('对照组：纯 ASCII 超长文本的截断行为不变（截断文案照常追加）', async () => {
    const { service, sent } = makeService();
    await service.sendFallback(1, 'x'.repeat(5000));
    expect(sent[0].text).toContain('（内容过长已截断，完整内容请在 Mao 桌面端/网页端查看）');
    expect(loneSurrogate(sent[0].text)).toBeNull();
  });
});
