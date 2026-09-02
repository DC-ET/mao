import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TextRenderer } from '../src/render/text-renderer';
import type { CliEvent, RunResult } from '../src/render/types';

let written: string[] = [];
let restore: (() => void) | undefined;

beforeEach(() => {
  written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  restore = () => {
    process.stdout.write = original;
  };
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    type: 'result',
    sessionId: 1,
    executionId: 'e1',
    status: 'COMPLETED',
    result: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolCalls: [],
    fileChanges: [],
    durationMs: 1,
    ...over,
  };
}

function feed(r: TextRenderer, events: CliEvent[]): void {
  for (const e of events) r.onEvent(e);
}

describe('TextRenderer', () => {
  it('prints the aggregated deltas with a single trailing newline', () => {
    const r = new TextRenderer();
    feed(r, [
      { type: 'content_delta', delta: '第一段' },
      { type: 'content_delta', delta: '第二段' },
    ]);
    r.finish(result());
    expect(written).toEqual(['第一段第二段\n']);
  });

  it('does not double the newline when the text already ends with one', () => {
    const r = new TextRenderer();
    feed(r, [{ type: 'content_delta', delta: 'done\n' }]);
    r.finish(result());
    expect(written).toEqual(['done\n']);
  });

  it('prefers the terminal result over the streamed text', () => {
    const r = new TextRenderer();
    feed(r, [{ type: 'content_delta', delta: 'streamed' }]);
    r.finish(result({ result: 'final' }));
    expect(written).toEqual(['final\n']);
  });

  it('keeps only the text after the last tool call', () => {
    const r = new TextRenderer();
    feed(r, [
      { type: 'content_delta', delta: '先看一下' },
      { type: 'tool_call_start', toolCallId: 'tc1', toolName: 'shell', arguments: '{}' },
      { type: 'tool_call_result', toolCallId: 'tc1', toolName: 'shell', status: 'SUCCESS', result: 'ok' },
      { type: 'content_delta', delta: '结论' },
    ]);
    r.finish(result());
    expect(written).toEqual(['结论\n']);
    expect(r.peek()).toBe('结论');
  });

  it('drops the aborted attempt on llm_stream_reset', () => {
    const r = new TextRenderer();
    feed(r, [
      { type: 'content_delta', delta: '半句' },
      { type: 'llm_stream_reset' },
      { type: 'content_delta', delta: '重来' },
    ]);
    expect(r.peek()).toBe('重来');
  });

  it('writes nothing when there is no text at all', () => {
    const r = new TextRenderer();
    r.finish(result());
    expect(written).toEqual([]);
  });

  it('writes nothing when the round ended on a tool call', () => {
    const r = new TextRenderer();
    feed(r, [
      { type: 'content_delta', delta: '思考' },
      { type: 'tool_call_start', toolCallId: 'tc1', toolName: 'shell', arguments: '{}' },
    ]);
    r.finish(result());
    expect(written).toEqual([]);
  });
});
