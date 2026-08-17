import { describe, expect, it, vi } from 'vitest';
import { WaitSubagentsTool } from './background-subagent-tools.js';

describe('WaitSubagentsTool', () => {
  it('waits through manager with default timeout', async () => {
    const manager = {
      waitForAll: vi.fn().mockResolvedValue({ completed: true, timedOut: false }),
      consumeResults: vi.fn().mockResolvedValue({ 1: '{"ok":true}' }),
      progress: vi.fn(),
    } as never;

    const tool = new WaitSubagentsTool(manager);
    const result = await tool.execute('{}', 1, null, null);

    expect(result).toContain('"completed":1');
    expect(result).toContain('"all_completed":true');
    expect(result).toContain('"timed_out":false');
    expect(manager.waitForAll).toHaveBeenCalledWith(1, null, 1_800_000);
    expect(manager.consumeResults).toHaveBeenCalledWith(1);
    expect(manager.progress).not.toHaveBeenCalled();
  });

  it('uses custom timeout and returns progress when timed out', async () => {
    const manager = {
      waitForAll: vi.fn().mockResolvedValue({ completed: false, timedOut: true }),
      consumeResults: vi.fn().mockResolvedValue({}),
      progress: vi.fn().mockResolvedValue([
        { taskId: 7, childSessionId: 8, agentType: 'coder', status: 'RUNNING' },
      ]),
    } as never;

    const tool = new WaitSubagentsTool(manager);
    const result = await tool.execute('{"timeout_seconds":5}', 1, null, null);

    expect(result).toContain('"completed":0');
    expect(result).toContain('"all_completed":false');
    expect(result).toContain('"timed_out":true');
    expect(result).toContain('"taskId":7');
    expect(manager.waitForAll).toHaveBeenCalledWith(1, null, 5000);
    expect(manager.progress).toHaveBeenCalledWith(1, null);
  });

  it('rejects invalid timeout', async () => {
    const manager = {
      waitForAll: vi.fn(),
      consumeResults: vi.fn(),
      progress: vi.fn(),
    } as never;

    const tool = new WaitSubagentsTool(manager);
    const result = await tool.execute('{"timeout_seconds":-1}', 1, null, null);

    expect(result).toContain('参数 timeout_seconds 必须是非负数字');
    expect(manager.waitForAll).not.toHaveBeenCalled();
  });
});
