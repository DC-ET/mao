import { describe, expect, it, vi } from 'vitest';
import { WaitSubagentsTool } from './background-subagent-tools.js';

describe('WaitSubagentsTool', () => {
  it('waits through manager without agentLoop dependency', async () => {
    const manager = {
      waitForAll: vi.fn().mockResolvedValue(undefined),
      consumeResults: vi.fn().mockResolvedValue({ 1: '{"ok":true}' }),
    } as never;

    const tool = new WaitSubagentsTool(manager);
    const result = await tool.execute('{}', 1, null, null);

    expect(result).toContain('"completed":1');
    expect(manager.waitForAll).toHaveBeenCalledWith(1, null);
    expect(manager.consumeResults).toHaveBeenCalledWith(1);
  });
});
