/**
 * 回归用例（第六轮逻辑 BUG 审查锚点转正，BUG-2）：
 * dingtalk/send.service.ts 的 limitReply / markdownMessage 曾按 UTF-16 码元硬切，
 * 切点落在代理对（emoji）中间时产出孤立代理，进入 msgParam JSON 后在对端渲染为
 * U+FFFD 乱码。同类缺陷 2026-11-22 第五轮已修复 6 处（card-progress-listener /
 * card-body / progress-card / merge-forward，统一换 common/utf8.ts 的
 * clipByCodePoints），本文件的回复截断路径是漏网点，已修复。
 *
 * 本用例断言「正确行为」：截断结果不得含孤立代理。
 * 对照组：同库的 clipByCodePoints 对同样输入无孤立代理，证明修复手段现成。
 */
import { describe, expect, it } from 'vitest';

import { limitReply, markdownMessage } from './send.service.js';
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

describe('dingtalk 回复截断的代理对完整性（回归）', () => {
  // '…（回复过长已截断）'.length === 10 → limitReply(text, 50) 的 room = 40
  const text = 'a'.repeat(39) + '🎉' + 'x'.repeat(200);

  it('limitReply 截断点落在 emoji 中间时不得留下孤立代理', () => {
    const result = limitReply(text, 50);
    expect(loneSurrogate(result.text)).toBeNull();
  });

  it('markdownMessage 的 title/text 不得含孤立代理', () => {
    const msg = markdownMessage(text, 50);
    const parsed = JSON.parse(msg.msgParam) as { title: string; text: string };
    expect(loneSurrogate(parsed.title)).toBeNull();
    expect(loneSurrogate(parsed.text)).toBeNull();
  });

  it('对照组：同库 clipByCodePoints 对同样输入无孤立代理（修复手段现成）', () => {
    expect(loneSurrogate(clipByCodePoints(text, 40))).toBeNull();
  });

  it('对照组：无 emoji 的截断行为不变（截断标记照常追加）', () => {
    const result = limitReply('x'.repeat(100), 50);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('…（回复过长已截断）')).toBe(true);
  });
});
