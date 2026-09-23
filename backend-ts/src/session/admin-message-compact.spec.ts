import { describe, expect, it } from 'vitest';
import { compactAdminTranscript, compactToolCalls, compactToolResult } from './admin-message-compact.js';

describe('compactAdminTranscript', () => {
  it('leaves short tool output unchanged', () => {
    expect(compactToolResult('ok')).toBe('ok');
    expect(compactToolResult(null)).toBeNull();
  });

  it('truncates long successful output without marking it failed', () => {
    const content = `{"success":true,"content":"${'a'.repeat(5000)}"}`;
    const compact = compactToolResult(content)!;
    expect(compact.length).toBeLessThanOrEqual(4000);
    expect(compact.startsWith('Tool execution failed')).toBe(false);
    expect(compact).toContain(`原文 ${content.length} 字符`);
  });

  it('keeps a failure prefix when exit code sits past the truncation point', () => {
    const content = `{"stdout":"${'a'.repeat(5000)}","exit_code":1}`;
    const compact = compactToolResult(content)!;
    expect(compact.startsWith('Tool execution failed')).toBe(true);
    expect(compact.length).toBeLessThanOrEqual(4000);
  });

  it('does not treat exit code 0 or source text mentioning error as failure', () => {
    const exitZero = `{"stdout":"${'a'.repeat(5000)}","exit_code":0}`;
    expect(compactToolResult(exitZero)!.startsWith('Tool execution failed')).toBe(false);
    const source = `{"success":true,"content":"${'const error = 1;'.padEnd(5000, 'x')}"}`;
    expect(compactToolResult(source)!.startsWith('Tool execution failed')).toBe(false);
  });

  it('truncates oversized write arguments and keeps the path', () => {
    const args = JSON.stringify({ path: 'scripts/blocks.py', content: 'a'.repeat(9000) });
    const raw = JSON.stringify([{
      id: 'c1',
      type: 'function',
      function: { name: 'write_file', arguments: args },
      summary: '写入 scripts/blocks.py',
    }]);
    const compact = compactToolCalls(raw)!;
    const parsed = JSON.parse(compact) as Array<{ function: { arguments: string }; summary: string }>;
    const shrunk = JSON.parse(parsed[0].function.arguments) as { path: string; content: string };
    expect(shrunk.path).toBe('scripts/blocks.py');
    expect(shrunk.content.length).toBeLessThan(args.length);
    expect(shrunk.content).toContain('参数过长已省略');
    expect(parsed[0].summary).toBe('写入 scripts/blocks.py');
  });

  it('compacts tool rows and assistant tool calls only', () => {
    const messages = compactAdminTranscript([
      { sessionId: 1, role: 'USER', content: 'hi' },
      { sessionId: 1, role: 'TOOL', content: 'b'.repeat(4500), toolCallId: 'c1' },
    ]);
    expect(messages[0].content).toBe('hi');
    expect(messages[1].content!.length).toBeLessThanOrEqual(4000);
  });
});
