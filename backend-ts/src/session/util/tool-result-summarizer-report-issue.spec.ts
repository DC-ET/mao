import { describe, expect, it } from 'vitest';
import { summarize } from './tool-result-summarizer.js';

/**
 * report_issue 摘要（AGENTS.md 强制：成功 / 失败 / 缺参三态）。
 * 摘要的消费者是管理端审计轨迹；用户侧消费者已被隐藏过滤拦截。
 */
describe('summarize(report_issue)', () => {
  it('成功：问题上报: <title 截断 30>', () => {
    expect(summarize(
      'report_issue',
      JSON.stringify({ category: 'tool_defect', title: 'shell 工具循环失败' }),
      JSON.stringify({ received: true, duplicate: false }),
    )).toBe('问题上报: shell 工具循环失败');
  });

  it('长 title 截断 30 字符', () => {
    const title = 'a'.repeat(40);
    expect(summarize(
      'report_issue',
      JSON.stringify({ title }),
      JSON.stringify({ received: true, duplicate: false }),
    )).toBe(`问题上报: ${'a'.repeat(30)}...`);
  });

  it('去重命中：标记为重复（审计轨迹区分新报与重复）', () => {
    expect(summarize(
      'report_issue',
      JSON.stringify({ title: '重复问题' }),
      JSON.stringify({ received: true, duplicate: true }),
    )).toBe('问题上报: 重复问题 (重复)');
  });

  it('失败：failureSuffix 兜底', () => {
    expect(summarize(
      'report_issue',
      JSON.stringify({ title: 'x' }),
      JSON.stringify({ error: 'invalid category' }),
    )).toBe('问题上报: x (失败: invalid category)');
  });

  it('缺参（无 title / 无 result）：退化为名称', () => {
    expect(summarize('report_issue', null, null)).toBe('问题上报');
    expect(summarize('report_issue', '{}', JSON.stringify({ received: true }))).toBe('问题上报');
  });
});
