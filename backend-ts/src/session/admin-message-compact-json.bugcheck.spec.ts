import { describe, expect, it } from 'vitest';
import { compactToolCalls } from './admin-message-compact.js';

/**
 * 回归用例：compactToolCalls 会把「合法但字段不超限的 JSON 参数」截成非法 JSON。
 *
 * 位置：backend-ts/src/session/admin-message-compact.ts:53-71 —— shrinkArgumentJson 的
 * 纯文本兜底（:70）按注释只应服务「参数不是 JSON」的情况，但它在 JSON 解析成功却
 * 没有任何顶层字符串字段超过 ARG_FIELD_LIMIT(8000) 时同样被触达（changed=false）。
 * 典型输入：两个 5000 字字段（各自未超 8000，总长超 8000）、或长内容藏在嵌套对象/数组里。
 * 结果 fn.arguments 被替换为 1500 字截断 + 中文省略提示——JSON.parse 必然抛错。
 *
 * 影响：管理后台会话详情用 parseToolArguments（admin/src/views/session/utils/chatMessage.ts:53）
 * 解析工具入参，解析失败后整个「工具输入」面板消失（后端原文本身是合法的）。
 *
 * 期望：截断后仍然是合法 JSON（顶层字段表不覆盖的形态至少保持原样可解析）。
 */
function toolCallsWithArguments(args: Record<string, unknown>): string {
  return JSON.stringify([
    { id: 'call-1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } },
  ]);
}

describe('compactToolCalls keeps tool arguments parseable', () => {
  it('does not corrupt JSON when two fields are large but each below the field limit', () => {
    const raw = toolCallsWithArguments({ path: 'a.txt', old_string: 'x'.repeat(5000), new_string: 'y'.repeat(5000) });
    const compacted = compactToolCalls(raw);
    expect(compacted).not.toBeNull();

    const list = JSON.parse(compacted!) as Array<{ function: { arguments: string } }>;
    // 截断提示可以存在，但 arguments 必须仍是合法 JSON
    expect(() => JSON.parse(list[0].function.arguments)).not.toThrow();
  });

  it('does not corrupt JSON when the long content is nested', () => {
    const raw = toolCallsWithArguments({ edits: Array.from({ length: 300 }, (_, i) => ({ old: `line-${i}-${'z'.repeat(40)}` })) });
    const compacted = compactToolCalls(raw)!;
    const list = JSON.parse(compacted) as Array<{ function: { arguments: string } }>;
    expect(() => JSON.parse(list[0].function.arguments)).not.toThrow();
  });

  it('still compacts an oversized top-level field into valid JSON (control group)', () => {
    const raw = toolCallsWithArguments({ path: 'a.txt', content: 'q'.repeat(9000) });
    const compacted = compactToolCalls(raw)!;
    const list = JSON.parse(compacted) as Array<{ function: { arguments: string } }>;
    const args = JSON.parse(list[0].function.arguments) as { content: string };
    expect(args.content.length).toBeLessThan(9000);
    expect(args.content).toContain('参数过长已省略');
  });
});
