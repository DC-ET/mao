import { describe, expect, it } from 'vitest';
import { SubAgentResultCollector } from './subagent-result-collector.js';

describe('SubAgentResultCollector', () => {
  it('returns an empty result when output contains only whitespace', () => {
    const collector = new SubAgentResultCollector();

    collector.onContentDelta(' \n');
    collector.onContentDelta('\t ');

    expect(collector.getResult()).toBe('');
  });

  it('keeps content that arrived before a later thinking block', () => {
    const collector = new SubAgentResultCollector();
    collector.onContentDelta('先给出的结论');
    collector.onThinkingStart();
    collector.onThinkingDelta('补充推理');
    collector.onContentDelta('以及后半句');
    expect(collector.getResult()).toBe('先给出的结论以及后半句');
  });

  it('keeps toolCallCount across stream resets and dedupes retried ids', () => {
    const collector = new SubAgentResultCollector();
    collector.onToolCallStart({ id: 'call-1' });
    collector.onToolCallStart({ id: 'call-2' });
    collector.onContentDelta('partial');

    // 整轮流重试：文本缓冲清空，但累计计数与已见 id 必须保留
    collector.onLlmStreamReset();
    expect(collector.getResult()).toBe('');
    expect(collector.toolCallCount).toBe(2);

    // 重试轮重发相同工具调用不重复计数，新调用正常累加
    collector.onToolCallStart({ id: 'call-1' });
    collector.onToolCallStart({ id: 'call-3' });
    expect(collector.toolCallCount).toBe(3);
  });
});
