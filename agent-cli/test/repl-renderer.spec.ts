import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplRenderer } from '../src/render/repl-renderer';
import type { RunResult } from '../src/render/types';
import { displayWidth } from '../src/ui/width';

function paint(s: string): string {
  let line = '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      out += `${line}\n`;
      line = '';
      continue;
    }
    if (s[i] === '\r') {
      line = '';
      continue;
    }
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    line += s[i];
  }
  return out + line;
}

function collect(over: { showTurnDividers?: boolean; colorFlag?: boolean; columns?: number; rows?: number } = {}) {
  let stdout = '';
  let stderr = '';
  let term = '';
  const renderer = new ReplRenderer({
    printMode: false,
    thinking: false,
    stdoutIsTty: true,
    colorFlag: over.colorFlag ?? false,
    agentName: '氛围编程',
    modelName: 'mimo-v2.5（plan）',
    executionMode: 'CLOUD',
    contextWindowTokens: 256000,
    showTurnDividers: over.showTurnDividers ?? false,
    columns: () => over.columns ?? 80,
    rows: () => over.rows ?? 0,
    stdout: { write: (s) => { stdout += s; term += s; } },
    stderr: { write: (s) => { stderr += s; term += s; } },
  });
  return {
    renderer,
    stdout: () => stdout,
    stderr: () => stderr,
    term: () => term,
  };
}

function visualLines(s: string): string[] {
  return paint(s).split('\n');
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
    expect(stderr()).toMatch(/5%/);
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
    expect(stdout()).toContain('ls -la');
    expect(stdout()).not.toContain('{"command"');
    expect(stdout().split('\n').filter(Boolean).length).toBeLessThan(6);
  });

  it('renders context as a percent of the model window', () => {
    const { renderer, stderr } = collect();
    renderer.startRound();
    renderer.onEvent({ type: 'context_window', estimated: 46080, actual: 46080 });
    renderer.finish(result);
    expect(stderr()).toMatch(/18%/);
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

  it('does not glue queue notices onto the spinner line', () => {
    vi.useFakeTimers();
    const { renderer, stdout, stderr } = collect({ showTurnDividers: true });
    renderer.startRound();
    renderer.onEvent({ type: 'llm_waiting', elapsedSeconds: 1 });
    renderer.setDraft('bbbbbb');
    renderer.announce('已排队（第 1 条）。/queue 查看，Ctrl+C 清空。');
    expect(stdout()).toContain('──');
    expect(stderr()).toContain('已排队（第 1 条）');
    const painted = paint(stderr());
    expect(painted.split('\n').some((l) => l.includes('已排队') && l.includes('等待 LLM'))).toBe(false);
    expect(painted.split('\n').some((l) => l.includes('已排队') && l.includes('草稿'))).toBe(false);
    renderer.finish({ ...result, result: '', toolCalls: [], durationMs: 6000 });
    expect(stdout()).toContain('(无文本回复)');
  });

  it('keeps short replies visible on a mixed stdout/stderr TTY', () => {
    const { renderer, term } = collect({ showTurnDividers: true, colorFlag: true });
    renderer.startRound();
    renderer.onEvent({ type: 'llm_waiting', elapsedSeconds: 1 });
    renderer.onEvent({ type: 'content_delta', delta: '我是助手' });
    renderer.finish(result);
    const painted = paint(term());
    expect(painted).toContain('我是助手');
    expect(painted).toMatch(/✔|5s/);
  });

  it('prints result text when the stream had no content_delta', () => {
    const { renderer, stdout } = collect({ showTurnDividers: true });
    renderer.startRound();
    renderer.finish({ ...result, result: '我是 ds-v4-flash' });
    expect(stdout()).toContain('我是 ds-v4-flash');
    expect(stdout()).not.toContain('(无文本回复)');
  });

  it('prints a user turn and claude-style tool card', () => {
    const { renderer, stdout } = collect();
    renderer.noteUser('hello');
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
      summary: '4 行输出',
    });
    expect(stdout()).toContain('hello');
    expect(stdout()).not.toContain('❯ hello');
    expect(stdout()).toContain('⏺');
    expect(stdout()).toContain('ls -la');
    expect(stdout()).toContain('4 行输出');
  });

  it('uses the alt screen and a full-width user block', () => {
    const { renderer, stdout } = collect({ rows: 24, colorFlag: true });
    const composer = renderer.getComposer();
    expect(composer?.tryStart()).toBe(true);
    try {
      renderer.printHeader(['mao-agent #1', '输入消息开始']);
      renderer.noteUser('hello');
      const out = stdout();
      expect(out).not.toContain('\x1b[?1049h');
      expect(out).toMatch(/\x1b\[3;\d+r/);
      expect(out).toContain('\x1b[48;5;236m');
      expect(out).toContain('hello');
    } finally {
      composer?.stop();
    }
  });

  it('keeps the status line to a single terminal row', () => {
    const { renderer, stderr } = collect({ columns: 60 });
    renderer.startRound();
    renderer.onEvent({ type: 'llm_waiting', elapsedSeconds: 1 });
    renderer.setDraft('bbbbbb');
    const lines = visualLines(stderr()).filter((l) => l.includes('思考中') || l.includes('等待 LLM') || l.includes('氛围编程'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(60);
    }
  });
});
