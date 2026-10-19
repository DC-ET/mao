import { describe, expect, it } from 'vitest';
import { toMessageVO } from './session-vo.js';
import type { Message } from './types.js';

/**
 * 回归用例：用户发的「纯文本 JSON 数组」经 toMessageVO 后 content 变成空串。
 *
 * 位置：backend-ts/src/session/session-vo.ts:361-386 —— 只要 content trim 后以 `[` 开头，
 * 就无条件按「多模态 content part 数组」解析；解析出的数组里没有 type==='text' 的元素时，
 * text 保持 ''，且不抛异常（catch 兜底不生效），最终 vo.content = ''。
 *
 * 同仓权威口径：harness/core/session-history-loader.ts:145-166 对同一输入有显式守卫
 * （isMultimodalContentParts，注释点名 `[1,2,3]`、`["a","b"]`、`[]` 三种纯文本 JSON 数组），
 * 校验不过则按原文返回。toMessageVO 漏了这道守卫，于是 LLM 能读到原文，而消息历史接口 /
 * 会话分享 / 管理端会话详情拿到的是空内容。
 *
 * 期望：非多模态结构的 content 原样返回；多模态结构照旧解析（对照组）。
 */
function message(content: string): Message {
  return { id: 1, sessionId: 1, role: 'USER', content } as Message;
}

describe('toMessageVO keeps plain-text JSON-array user messages', () => {
  it('does not blank out a numeric JSON array', () => {
    expect(toMessageVO(message('[1,2,3]')).content).toBe('[1,2,3]');
  });

  it('does not blank out an array of strings', () => {
    expect(toMessageVO(message('["怎么配置","端口"]')).content).toBe('["怎么配置","端口"]');
  });

  it('does not blank out an empty JSON array', () => {
    expect(toMessageVO(message('[]')).content).toBe('[]');
  });

  it('does not blank out an array of objects that are not content parts', () => {
    const raw = '[{"foo":1},{"bar":2}]';
    expect(toMessageVO(message(raw)).content).toBe(raw);
  });

  it('still expands real multimodal content parts (control group)', () => {
    const raw = JSON.stringify([
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
    const vo = toMessageVO(message(raw));
    expect(vo.content).toBe('看这张图');
    expect(vo.images).toEqual(['https://example.com/a.png']);
  });
});
