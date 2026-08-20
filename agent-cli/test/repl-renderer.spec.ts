import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplRenderer } from '../src/render/repl-renderer';
import type { RunResult } from '../src/render/types';

function collect() {
  let stdout = '';
  let stderr = '';
  const renderer = new ReplRenderer({
    printMode: false,
    thinking: false,
    stdoutIsTty: true,
    colorFlag: false,
    agentName: '氛围编程',
    modelName: 'mimo',
    executionMode: 'CLOUD',
    contextWindowTokens: 256000,
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
    const stderrAfterText = stderr();
    renderer.onEvent({ type: 'llm_waiting', elapsedSeconds: 3 });
    renderer.onEvent({ type: 'context_window', estimated: 13936, actual: 14000 });
    vi.advanceTimersByTime(250);
    expect(stdout()).toBe('你好');
    expect(stderr().slice(stderrAfterText.length)).not.toContain('\r');
    expect(stderr()).not.toMatch(/13936%/);
    renderer.finish(result);
    expect(stdout().endsWith('\n') || stdout().includes('你好\n') || stdout().includes('你好')).toBe(true);
    expect(stderr()).toMatch(/Context: 5%/);
  });

  it('renders context as a percent of the model window', () => {
    const { renderer, stderr } = collect();
    renderer.startRound();
    renderer.onEvent({ type: 'context_window', estimated: 46080, actual: 46080 });
    renderer.finish(result);
    expect(stderr()).toMatch(/Context: 18%/);
  });
});
