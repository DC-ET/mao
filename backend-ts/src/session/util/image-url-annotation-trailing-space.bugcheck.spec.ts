import { describe, expect, it } from 'vitest';
import {
  appendImageUrlLines,
  buildUserContentParts,
  stripImageUrlLines,
} from './image-url-annotation.js';

/**
 * Bugcheck：注入行剥离正则对行尾空白的容忍度（2026-10-23 审查 BUG-4）。
 *
 * image-url-annotation.ts:12：
 *   const IMAGE_URL_LINE_PATTERN = /^\[图片 \d+\] \S+$/gm;
 *
 * `\S+$` 要求整行以非空白字符结尾。`m` 标志下 `$` 匹配「行终结符之前的位置」，
 * 而 `\S` 排不掉 `\r`、`\t`、空格——所以行尾带任一空白字符时整行不匹配。
 *
 * 编辑往返依赖这条正则做幂等（session.service.ts:1601 buildEditContent →
 * buildUserContentParts → appendImageUrlLines → stripImageUrlLines 先剥后追加）。
 * 注入行一旦带行尾空白落库，编辑后 strip 剥不掉 → 再追加一份 → 注入行翻倍，
 * 且翻倍的行会进 LLM 上下文与气泡展示。
 *
 * 现实触发路径（前端用户操作可达，不需要渠道配合）：
 *   MessageBubble.vue:344/350 把含注入行的落库原文塞进 <textarea>，
 *   用户对行尾敲空格 / 粘贴带入 → confirmEdit 原样回传 → 后端剥不掉。
 *
 * 另一条路径：正文带 `\r`（CRLF）时注入行以 `...png\r` 形态落库。
 */

const URL_A = 'https://a.example/b.png';

describe('注入行剥离的行尾空白容忍度', () => {
  it('BUG-4：行尾带空格的注入行剥不掉，编辑往返后翻倍', () => {
    // 用户在编辑框里对注入行行尾敲了两个空格
    const edited = `看这张\n\n[图片 1] ${URL_A}  `;
    const stripped = stripImageUrlLines(edited);
    // 期望：注入行被剥掉，只剩正文
    expect(stripped).toBe('看这张');
    // 实际：`\S+$` 不匹配行尾空格 → 原样返回
  })

  it('BUG-4：CRLF 结尾的注入行剥不掉且残留 \\r', () => {
    const edited = `上文\r\n\r\n[图片 1] ${URL_A}\r`;
    const stripped = stripImageUrlLines(edited);
    expect(stripped).toBe('上文');
  })

  it('BUG-4：appendImageUrlLines 对带行尾空格的正文失去幂等性', () => {
    const once = appendImageUrlLines('看这张', [URL_A]);
    expect(once).toBe(`看这张\n\n[图片 1] ${URL_A}`);
    // 模拟编辑往返：用户在注入行行尾加了空格后再次提交
    const withTrailingSpace = `${once} `;
    const twice = appendImageUrlLines(withTrailingSpace, [URL_A]);
    // 期望：幂等，结果不变
    expect(twice).toBe(once);
    // 实际：剥不掉旧行 → 追加新行 → 注入行翻倍
  })

  it('BUG-4：buildUserContentParts 落库文本出现两份注入行', () => {
    const withTrailingSpace = `看这张\n\n[图片 1] ${URL_A} `;
    const parts = buildUserContentParts(withTrailingSpace, [URL_A]);
    const text = parts.find((p) => p.type === 'text')?.text ?? '';
    const occurrences = text.split(`[图片 1] ${URL_A}`).length - 1;
    // 期望：1 份
    expect(occurrences).toBe(1);
  })

  it('正确性基线：干净注入行的编辑往返是幂等的', () => {
    const once = appendImageUrlLines('看这张', [URL_A]);
    const twice = appendImageUrlLines(once, [URL_A]);
    expect(twice).toBe(once);
    expect(stripImageUrlLines(once)).toBe('看这张');
  })

  it('正确性基线：不含注入行的正文原样返回', () => {
    expect(stripImageUrlLines('普通正文，没有注入行')).toBe('普通正文，没有注入行');
  })
})
