import { describe, expect, it } from 'vitest';
import { FeishuCardProgressListener, countCompletedAgentRounds } from './card-progress-listener.js';

describe('FeishuCardProgressListener', () => {
  it('updates one round with content and tool summary, then completes', async () => {
    const updates: Array<{ status: string; round: number; content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (status, round, content, tools) => { updates.push({ status, round, content, tools }); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('摘要');
    listener.onToolCallStart({ id: 'tool-1', function: { name: 'read_file', arguments: '{}' } });
    listener.onToolCallResult('tool-1', '读取成功');
    listener.onRoundEnd(1);
    await listener.complete('最终答案');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual([
      { status: 'RUNNING', round: 1, content: '摘要', tools: ['read_file：执行中…'] },
      { status: 'RUNNING', round: 1, content: '摘要', tools: ['read_file：读取 文件'] },
      { status: 'COMPLETED', round: 1, content: '最终答案', tools: [] },
    ]);
  });

  it('keeps tool results matched when results arrive out of order', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({ update: async (_status, _round, _content, tools) => { updates.push(tools); } });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'a', function: { name: 'first', arguments: '{}' } });
    listener.onToolCallResult('a', 'first result');
    listener.onToolCallStart({ id: 'b', function: { name: 'second', arguments: '{}' } });
    listener.onToolCallResult('b', 'second result');
    listener.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual(['first：执行中…']);
    expect(updates[updates.length - 1]).toEqual(['first：first', 'second：执行中…']);
  });

  it('shows the shell command while the tool is still running', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"npm test"}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual(['shell：`npm test`（执行中）']);
  });

  it('refreshes the card when streamed shell arguments become parseable', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":' } });
    listener.onToolCallArgsDelta('sh', '{"command":"pwd && ls"}');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual(['shell：执行中…']);
    expect(updates[updates.length - 1]).toEqual(['shell：`pwd && ls`（执行中）']);
  });

  it('truncates a long running shell command and keeps write_stdin readable', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    const longCommand = `echo ${'a'.repeat(260)}`;
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'long', function: { name: 'shell', arguments: JSON.stringify({ command: longCommand }) } });
    listener.onToolCallStart({ id: 'stdin', function: { name: 'shell', arguments: '{"action":"write_stdin","input":"hello world"}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0][0]).toBe(`shell：\`${longCommand.slice(0, 240)}…\`（执行中）`);
    expect(updates[updates.length - 1]).toEqual([
      `shell：\`${longCommand.slice(0, 240)}…\`（执行中）`,
      'shell：写入 stdin: hello world（执行中）',
    ]);
  });

  it('replaces the running shell command with the result summary', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    listener.onToolCallResult('sh', '{"exit_code":0,"output":"/tmp"}');
    listener.onRoundEnd(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual(['shell：`pwd`（执行中）']);
    expect(updates[updates.length - 1]).toEqual(['shell：执行 pwd']);
  });

  it('swallows card update failures', async () => {
    const listener = new FeishuCardProgressListener({ update: async () => { throw new Error('offline'); } });
    listener.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    await expect(listener.complete('done')).resolves.toBe(false);
  });

  it('serializes updates and reports cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const updates: string[] = [];
    const listener = new FeishuCardProgressListener({
      update: async (status) => { await gate; updates.push(status); },
    });
    listener.onRoundStart(1);
    listener.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    listener.onRoundEnd(1);
    const cancelled = listener.cancel();
    release();
    await cancelled;
    expect(updates).toEqual(['RUNNING', 'CANCELLED']);
  });

  it('keeps markdown breaks when newlines arrive as their own deltas', async () => {
    const updates: string[] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, content) => { updates.push(content); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('先给结论。');
    listener.onContentDelta('\n\n');
    listener.onToolCallStart({ id: 'ask', function: { name: 'ask_user_questions', arguments: '{}' } });
    listener.onContentDelta('## 一、根因\n');
    listener.onContentDelta('\n');
    listener.onContentDelta('1. 提示词压过只读。');
    listener.onRoundEnd(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1]).toBe('先给结论。\n\n## 一、根因\n\n1. 提示词压过只读。');
  });

  it('offsets recovered loop rounds so the card continues from prior history', async () => {
    const updates: Array<{ round: number; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, round, _content, tools) => { updates.push({ round, tools }); },
    }, 78);
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    listener.onToolCallResult('sh', '{"exit_code":0,"output":"/tmp"}');
    listener.onRoundEnd(1);
    await listener.complete('done');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual({ round: 79, tools: ['shell：`pwd`（执行中）'] });
    expect(updates[updates.length - 2]).toEqual({ round: 79, tools: ['shell：执行 pwd'] });
    expect(updates[updates.length - 1]).toEqual({ round: 79, tools: [] });
  });
});

describe('countCompletedAgentRounds', () => {
  it('counts assistant messages after the last user turn', () => {
    expect(countCompletedAgentRounds(null)).toBe(0);
    expect(countCompletedAgentRounds([])).toBe(0);
    expect(countCompletedAgentRounds([
      { role: 'USER' }, { role: 'ASSISTANT' }, { role: 'TOOL' }, { role: 'ASSISTANT' },
    ])).toBe(2);
    expect(countCompletedAgentRounds([
      { role: 'USER' }, { role: 'ASSISTANT' },
      { role: 'USER' }, { role: 'ASSISTANT' }, { role: 'ASSISTANT' }, { role: 'ASSISTANT' },
    ])).toBe(3);
    expect(countCompletedAgentRounds([{ role: 'SYSTEM' }, { role: 'ASSISTANT' }])).toBe(1);
  });
});