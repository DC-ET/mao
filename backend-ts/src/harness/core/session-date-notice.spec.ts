import { describe, expect, it } from 'vitest';
import { applyDateChangeNotices, buildDateChangeTag, formatChineseWeekday } from './session-date-notice.js';
import type { ChatMessage } from '../llm/chat-request.js';

function user(content: unknown, senderYmd?: string): ChatMessage {
  const msg: ChatMessage = { role: 'user', content };
  if (senderYmd) msg.senderYmd = senderYmd;
  return msg;
}

/** 取出某条消息正文的纯文本（字符串 content 或数组 content 的首个 text part）。 */
function textOf(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const first = msg.content[0] as { type?: string; text?: string } | undefined;
    return first?.type === 'text' ? (first.text ?? '') : '';
  }
  return '';
}

describe('applyDateChangeNotices', () => {
  it('same-day messages get no tag', () => {
    const messages = [user('a', '2026-10-12'), user('b', '2026-10-12'), user('c', '2026-10-12')];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(messages.map((m) => textOf(m))).toEqual(['a', 'b', 'c']);
  });

  it('crossing one day tags only the first message of the new day', () => {
    const messages = [user('a', '2026-10-12'), user('b', '2026-10-13'), user('c', '2026-10-13')];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(textOf(messages[0])).toBe('a');
    expect(textOf(messages[1])).toContain('<date-change>');
    expect(textOf(messages[1])).toContain('2026-10-13（星期二）');
    expect(textOf(messages[1])).toContain('这是系统注入的提示，不是用户说的话');
    expect(textOf(messages[1]).endsWith('\n\nb')).toBe(true);
    expect(textOf(messages[2])).toBe('c');
  });

  it('multi-day gap produces a single tag carrying the new date', () => {
    const messages = [user('a', '2026-10-12'), user('b', '2026-10-15')];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(textOf(messages[0])).toBe('a');
    expect(textOf(messages[1])).toContain('2026-10-15（星期四）');
  });

  it('first message on the anchor day gets no tag', () => {
    const messages = [user('a', '2026-10-12')];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(textOf(messages[0])).toBe('a');
  });

  it('anchor older than first message (deleted first message) still compares correctly', () => {
    // 锚点来自更早已被软删的首条消息；窗口内首条消息日期与锚点不同 → 按规则打标签。
    const messages = [user('a', '2026-10-13'), user('b', '2026-10-13')];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(textOf(messages[0])).toContain('2026-10-13（星期二）');
    expect(textOf(messages[1])).toBe('b');
  });

  it('previousUserYmdBefore takes precedence over baseYmd as the initial reference', () => {
    // 压缩边界前最后一条用户消息是 10-13，窗口内首条也是 10-13 → 不打标签。
    const messages = [user('a', '2026-10-13'), user('b', '2026-10-14')];
    applyDateChangeNotices(messages, '2026-10-12', '2026-10-13');
    expect(textOf(messages[0])).toBe('a');
    expect(textOf(messages[1])).toContain('2026-10-14（星期三）');
  });

  it('previousUserYmdBefore across the compaction boundary still detects the drift', () => {
    // 边界前是 10-12，边界后窗口内首条是 10-14（跨了两天）→ 打一次标签。
    const messages = [user('a', '2026-10-14'), user('b', '2026-10-14')];
    applyDateChangeNotices(messages, '2026-10-12', '2026-10-12');
    expect(textOf(messages[0])).toContain('2026-10-14（星期三）');
    expect(textOf(messages[1])).toBe('b');
  });

  it('multimodal content gains a leading text part and keeps image order', () => {
    const imageA = { type: 'image_url', imageUrl: { url: 'data:a' } };
    const imageB = { type: 'image_url', imageUrl: { url: 'data:b' } };
    const messages = [user([imageA, imageB], '2026-10-13')];
    applyDateChangeNotices(messages, '2026-10-12', null);
    const parts = messages[0].content as Array<{ type?: string; text?: string; imageUrl?: { url: string } }>;
    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('2026-10-13');
    expect(parts[1]).toBe(imageA);
    expect(parts[2]).toBe(imageB);
  });

  it('does not mutate the original nested content array (shallow-copy trap)', () => {
    const imageA = { type: 'image_url', imageUrl: { url: 'data:a' } };
    const imageB = { type: 'image_url', imageUrl: { url: 'data:b' } };
    const original = [user([imageA, imageB], '2026-10-13')];
    const originalContent = original[0].content as unknown[];
    // buildRequest 的浅拷贝：嵌套的 content 数组与原对象共享引用
    const copy = original.map((m) => ({ ...m }));
    applyDateChangeNotices(copy, '2026-10-12', null);
    // 禁止原地 unshift：原数组必须一个元素都没多
    expect(originalContent).toHaveLength(2);
    expect(originalContent[0]).toBe(imageA);
    expect(originalContent[1]).toBe(imageB);
    expect(original[0].senderYmd).toBe('2026-10-13');
    const copied = copy[0].content as Array<{ type?: string; text?: string }>;
    expect(copied).toHaveLength(3);
    expect(copied[0].type).toBe('text');
    expect(copied[0].text).toContain('<date-change>');
    expect(copied[1]).toBe(imageA);
    expect(copied[2]).toBe(imageB);
  });

  it('does not mutate the original string content either', () => {
    const original = [user('hello', '2026-10-13')];
    const copy = original.map((m) => ({ ...m }));
    applyDateChangeNotices(copy, '2026-10-12', null);
    expect(original[0].content).toBe('hello');
    expect(copy[0].content).not.toBe(original[0].content);
  });

  it('messages without senderYmd are skipped and do not pollute previousYmd', () => {
    const messages = [
      user('a', '2026-10-12'),
      user('no-stamp'),
      user('b', '2026-10-13'),
      user('c', '2026-10-13'),
    ];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(textOf(messages[0])).toBe('a');
    expect(textOf(messages[1])).toBe('no-stamp');
    expect(textOf(messages[2])).toContain('2026-10-13');
    expect(textOf(messages[3])).toBe('c');
  });

  it('non-user roles are never touched even when they carry senderYmd', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'reply', senderYmd: '2026-10-13' },
      { role: 'tool', toolCallId: 'c1', content: 'out', senderYmd: '2026-10-13' },
      user('q', '2026-10-12'),
    ];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(messages[0].content).toBe('reply');
    expect(messages[1].content).toBe('out');
    expect(messages[2].content).toBe('q');
  });

  it('empty baseYmd is a no-op', () => {
    const messages = [user('a', '2026-10-13')];
    applyDateChangeNotices(messages, '', null);
    expect(textOf(messages[0])).toBe('a');
  });

  it('preserves every other field when replacing the message object', () => {
    const messages: ChatMessage[] = [{
      role: 'user', content: 'hi', senderYmd: '2026-10-13', name: 'alice',
    }];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(messages[0].senderYmd).toBe('2026-10-13');
    expect(messages[0].name).toBe('alice');
    expect(messages[0].role).toBe('user');
  });

  it('null content is rendered as an empty body after the tag', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: null, senderYmd: '2026-10-13' }];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(String(messages[0].content)).toBe(`${buildDateChangeTag('2026-10-13')}\n\n`);
  });

  it('empty content string gets the tag only', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '', senderYmd: '2026-10-13' }];
    applyDateChangeNotices(messages, '2026-10-12', null);
    expect(String(messages[0].content)).toBe(`${buildDateChangeTag('2026-10-13')}\n\n`);
  });
});

describe('buildDateChangeTag / formatChineseWeekday', () => {
  it('tag mentions the date, weekday and its system-injected nature', () => {
    const tag = buildDateChangeTag('2026-10-13');
    expect(tag.startsWith('<date-change>系统提示：当前日期已变更为 2026-10-13（星期二）。')).toBe(true);
    expect(tag.endsWith('</date-change>')).toBe(true);
    expect(tag).toContain('需要精确到时分秒请用 shell 执行 date');
  });

  it('weekday parsing covers every day and rejects garbage', () => {
    expect(formatChineseWeekday('2026-10-12')).toBe('星期一');
    expect(formatChineseWeekday('2026-10-13')).toBe('星期二');
    expect(formatChineseWeekday('2026-10-14')).toBe('星期三');
    expect(formatChineseWeekday('2026-10-15')).toBe('星期四');
    expect(formatChineseWeekday('2026-10-16')).toBe('星期五');
    expect(formatChineseWeekday('2026-10-17')).toBe('星期六');
    expect(formatChineseWeekday('2026-10-18')).toBe('星期日');
    expect(formatChineseWeekday('')).toBeNull();
    expect(formatChineseWeekday(null)).toBeNull();
    expect(formatChineseWeekday(undefined)).toBeNull();
    expect(formatChineseWeekday('not-a-date')).toBeNull();
  });
});
