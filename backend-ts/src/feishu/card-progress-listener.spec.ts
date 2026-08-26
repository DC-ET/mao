import { describe, expect, it } from 'vitest';
import { FeishuCardProgressListener } from './card-progress-listener.js';

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
});