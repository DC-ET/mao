import { describe, expect, it } from 'vitest';
import { ToolCallContext } from './tool-call-context.js';

describe('ToolCallContext', () => {
  it('run isolates concurrent tool_call_id after awaits', async () => {
    const seen = await Promise.all([
      ToolCallContext.run('call-a', async () => {
        await new Promise((r) => setTimeout(r, 20));
        return ToolCallContext.getToolCallId();
      }),
      ToolCallContext.run('call-b', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return ToolCallContext.getToolCallId();
      }),
    ]);
    expect(seen).toEqual(['call-a', 'call-b']);
  });
});
