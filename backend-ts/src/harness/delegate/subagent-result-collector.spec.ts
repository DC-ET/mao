import { describe, expect, it } from 'vitest';
import { SubAgentResultCollector } from './subagent-result-collector.js';

describe('SubAgentResultCollector', () => {
  it('returns an empty result when output contains only whitespace', () => {
    const collector = new SubAgentResultCollector();

    collector.onContentDelta(' \n');
    collector.onContentDelta('\t ');

    expect(collector.getResult()).toBe('');
  });
});
