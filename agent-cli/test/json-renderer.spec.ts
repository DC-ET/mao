import { afterEach, describe, expect, it } from 'vitest';
import { JsonRenderer } from '../src/render/json-renderer';
import type { CliEvent, RunResult } from '../src/render/types';

function collect(): { lines: unknown[]; renderer: JsonRenderer } {
  const lines: unknown[] = [];
  const renderer = new JsonRenderer({
    stream: true,
    streamPartial: false,
    includeToolIo: false,
    write: (obj) => lines.push(obj),
  });
  return { lines, renderer };
}

const result: RunResult = {
  type: 'result',
  sessionId: 129,
  executionId: '8f2c1d3e',
  status: 'COMPLETED',
  result: 'backend-ts 编译通过',
  usage: { promptTokens: 3400, completionTokens: 210, totalTokens: 3610 },
  toolCalls: [{ toolCallId: 'tc_1', toolName: 'shell', status: 'SUCCESS' }],
  fileChanges: [],
  durationMs: 15230,
};

describe('stream-json / json schema golden', () => {
  const events: CliEvent[] = [
    { type: 'session_started', sessionId: 129, executionId: '8f2c1d3e' },
    { type: 'content_delta', delta: '我先看一下' },
    { type: 'tool_call_start', toolCallId: 'tc_1', toolName: 'shell', arguments: '{"command":"ls"}' },
    { type: 'tool_call_result', toolCallId: 'tc_1', toolName: 'shell', status: 'SUCCESS', result: 'ok' },
    { type: 'content_delta', delta: '已完成' },
  ];

  it('aggregates assistant text between tool calls', () => {
    const { lines, renderer } = collect();
    for (const e of events) renderer.onEvent(e);
    renderer.finish(result);
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'session_started', sessionId: 129 });
    expect(lines[1]).toMatchObject({ type: 'assistant', message: { content: [{ type: 'text', text: '我先看一下' }] } });
    expect(lines[2]).toMatchObject({ type: 'tool_call', status: 'start', tool_call_id: 'tc_1', tool_name: 'shell' });
    expect(lines[3]).toMatchObject({ type: 'tool_call', status: 'result', tool_call_id: 'tc_1' });
    expect(lines[4]).toMatchObject({ type: 'assistant', message: { content: [{ type: 'text', text: '已完成' }] } });
    expect(lines[5]).toMatchObject({
      type: 'result',
      status: 'COMPLETED',
      sessionId: 129,
      usage: { totalTokens: 3610 },
      durationMs: 15230,
    });
  });

  it('json mode emits a single result object', () => {
    const lines: unknown[] = [];
    const renderer = new JsonRenderer({
      stream: false,
      streamPartial: false,
      includeToolIo: false,
      write: (obj) => lines.push(obj),
    });
    for (const e of events) renderer.onEvent(e);
    renderer.finish(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'result',
      sessionId: 129,
      executionId: '8f2c1d3e',
      status: 'COMPLETED',
      result: 'backend-ts 编译通过',
    });
    expect((lines[0] as { toolCalls: unknown[] }).toolCalls[0]).not.toHaveProperty('arguments');
  });
});

afterEach(() => {
  // keep vitest hooks available for isolation
});
