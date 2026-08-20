import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplRenderer } from '../src/render/repl-renderer';
import type { RunResult } from '../src/render/types';

function collect(over: { showTurnDividers?: boolean; colorFlag?: boolean; columns?: number; rows?: number } = {}) {
  let stdout = '';
  let stderr = '';
  const renderer = new ReplRenderer({
    printMode: false,
    thinking: false,
    stdoutIsTty: true,
    colorFlag: over.colorFlag ?? false,
    agentName: '氛围编程',
    modelName: 'mimo',
    executionMode: 'CLOUD',
    contextWindowTokens: 256000,
    showTurnDividers: over.showTurnDividers ?? false,
    columns: () => over.columns ?? 80,
    rows: () => over.rows ?? 0,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return {
    renderer,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const result: RunResult = {
  type: 'result',
  sessionId: 1,
  executionId: 'eid',
  status: 'COMPLETED',
  result: '你好',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  toolCalls: [],
  fileChanges: [],
  durationMs: 10,
};

describe('ReplRenderer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not let the status bar \\r wipe streamed assistant text', () => {
    vi.useFakeTimers();
    const { renderer, stdout, stderr } = collect();
    renderer.startRound();
    renderer.onEvent({ type: 'content_delta', delta: '你好' });
    expect(stdout()).toBe('你好');
    renderer.onEvent({ type: 'llm_waiting', elapsedSeconds: 3 });
    renderer.onEvent({ type: 'context_window', estimated: 13936, actual: 14000 });
    vi.advanceTimersByTime(250);
    expect(stdout()).toBe('你好');
    expect(stderr()).toContain('等待 LLM');
    expect(stderr()).not.toMatch(/13936%/);
    renderer.finish(result);
    expect(stderr()).toMatch(/Context: 5%/);
  });

  it('keeps a status line after complete-line output', () => {
    vi.useFakeTimers();
    const { renderer, stdout, stderr } = collect();
    renderer.startRound();
    renderer.onEvent({ type: 'content_delta', delta: '第一行\n' });
    expect(stdout()).toBe('第一行\n');
    expect(stderr()).toContain('思考中');
    vi.advanceTimersByTime(160);
    expect(stderr()).toContain('\r');
    renderer.finish(result);
  });

  it('folds tool results unless verbose', () => {
    const { renderer, stdout } = collect();
    renderer.startRound();
    renderer.onEvent({
      type: 'tool_call_start',
      toolCallId: 't1',
      toolName: 'shell',
      arguments: '{"command":"ls -la"}',
    });
    renderer.onEvent({
      type: 'tool_call_result',
      toolCallId: 't1',
      toolName: 'shell',
      status: 'SUCCESS',
      summary: 'a\nb\nc\nd\ne\nvery long output that should be truncated to a single short line for scanability',
    });
    expect(stdout()).toContain('shell');
    expect(stdout().split('\n').filter(Boolean).length).toBeLessThan(6);
  });

  it('renders context as a percent of the model window', () => {
    const { renderer, stderr } = collect();
    renderer.startRound();
    renderer.onEvent({ type: 'context_window', estimated: 46080, actual: 46080 });
    renderer.finish(result);
    expect(stderr()).toMatch(/Context: 18%/);
  });

  it('streams markdown raw and rewrites the block when color is on', () => {
    const { renderer, stdout } = collect({ colorFlag: true, columns: 80 });
    renderer.startRound();
    renderer.onEvent({ type: 'content_delta', delta: '# Title\n' });
    expect(stdout()).toContain('# Title');
    renderer.onEvent({ type: 'tool_call_start', toolCallId: 't1', toolName: 'shell' });
    expect(stdout()).toContain('\x1b[1mTitle\x1b[0m');
    expect(stdout()).toContain('\x1b[');
  });

  it('shows todo progress on the status line', () => {
    const { renderer, stderr } = collect();
    renderer.startRound();
    renderer.onEvent({
      type: 'todo_updated',
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
    });
    expect(stderr()).toContain('Todo 1/2');
    renderer.finish(result);
    expect(stderr()).toContain('Todo 1/2');
  });

  it('pins mid-stream status to the bottom row when rows are known', () => {
    const { renderer, stdout, stderr } = collect({ rows: 24 });
    renderer.startRound();
    renderer.onEvent({ type: 'content_delta', delta: '你好' });
    renderer.onEvent({ type: 'llm_waiting', elapsedSeconds: 2 });
    expect(stdout()).toBe('你好');
    expect(stderr()).toContain('\x1b[s');
    expect(stderr()).toContain('24;1H');
    expect(stderr()).toContain('等待 LLM');
    renderer.finish(result);
  });
});
