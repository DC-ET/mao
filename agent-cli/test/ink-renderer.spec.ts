import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { CliEvent, RunResult } from '../src/render/types';
import type { TuiHandle } from '../src/tui/types';

interface FakeOut extends NodeJS.WriteStream {
  chunks: string[];
}

function fakeStdout(rows = 24, columns = 80): FakeOut {
  const s = new PassThrough() as unknown as FakeOut;
  s.chunks = [];
  s.on('data', (c: Buffer) => s.chunks.push(c.toString('utf8')));
  Object.assign(s, { rows, columns, isTTY: true });
  return s;
}

function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: true, setRawMode: () => s });
  return s;
}

const mounted: TuiHandle[] = [];

function mount(opts: { rows?: number; columns?: number; thinking?: boolean; dividers?: boolean } = {}) {
  const out = fakeStdout(opts.rows, opts.columns);
  const stdin = fakeStdin();
  const renderer = new InkTuiRenderer({
    stdout: out,
    stdin,
    welcomeLines: ['mao-agent 测试'],
    agentName: 'A',
    modelName: 'M',
    thinking: opts.thinking,
    showTurnDividers: opts.dividers,
  });
  const handle = renderer.mount();
  mounted.push(handle);
  return {
    renderer,
    out,
    stdin,
    handle,
    text: () => out.chunks.join(''),
    /** 剥掉 ANSI 控制序列，只留下写到终端的可见文本（含历史帧）。 */
    plain: () => out.chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    /**
     * 只取最后一帧的可见文本。live 区每帧都会被 log-update 擦掉重画，
     * 因此「当前屏幕上有什么」必须看最后一帧，累计输出里会留下所有中间态。
     */
    frame: () => {
      const parts = out.chunks.join('').split('\x1b[G');
      return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    },
    /** 丢掉此前所有输出，后续 plain() 只反映之后新写入的内容。 */
    reset: () => {
      out.chunks.length = 0;
    },
  };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function runResult(patch: Partial<RunResult> = {}): RunResult {
  return {
    type: 'result',
    sessionId: 1,
    executionId: 'e1',
    status: 'COMPLETED',
    result: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolCalls: [],
    fileChanges: [],
    durationMs: 2000,
    ...patch,
  };
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe('InkTuiRenderer static-first rendering', () => {
  it('never triggers Ink 的整屏重绘分支, even under a long stream', async () => {
    const t = mount({ rows: 24 });
    t.renderer.seedChrome(['历史一行']);
    t.renderer.startRound();
    for (let i = 0; i < 200; i++) {
      t.renderer.onEvent({ type: 'content_delta', delta: `行 ${i}\n` });
    }
    await tick();
    // \x1b[2J 只应由 /clear 主动发出；Ink 的 clearTerminal 分支会清掉 scrollback
    expect(t.text()).not.toContain('\x1b[2J');
    expect(t.plain()).toContain('行 199');
  });

  it('commits finished lines while streaming and flushes the partial tail on finish', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'content_delta', delta: '第一行\n未完成尾巴' });
    await tick();
    expect(t.plain()).toContain('第一行');
    t.renderer.finish(runResult());
    await tick();
    expect(t.plain()).toContain('未完成尾巴');
  });

  it('renders headings without the markdown prefix', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'content_delta', delta: '## 标题\n' });
    await tick();
    expect(t.plain()).toContain('标题');
    expect(t.plain()).not.toContain('## 标题');
  });

  it('keeps fenced code verbatim across deltas', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'content_delta', delta: '```ts\n' });
    t.renderer.onEvent({ type: 'content_delta', delta: '# not a heading\n```\n' });
    await tick();
    expect(t.plain()).toContain('# not a heading');
  });

  it('drops only the unfinished tail on llm_stream_reset', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'content_delta', delta: '已定稿\n重开前的尾巴' });
    await tick();
    expect(t.plain()).toContain('已定稿');
    t.reset();
    t.renderer.onEvent({ type: 'llm_stream_reset' });
    t.renderer.finish(runResult());
    await tick();
    // 重置后未定稿的尾巴不再被写入转录；已定稿的行留在 Static 里不会重绘
    expect(t.plain()).not.toContain('重开前的尾巴');
  });
});

describe('InkTuiRenderer tool calls', () => {
  it('shows a running tool live and finalises it on result', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({
      type: 'tool_call_start',
      toolCallId: 't1',
      toolName: 'shell',
      arguments: '{"command":"ls -la"}',
    });
    await tick();
    expect(t.plain()).toContain('ls -la');
    t.renderer.onEvent({ type: 'tool_call_result', toolCallId: 't1', toolName: 'shell', status: 'SUCCESS', summary: '12 个文件' });
    await tick();
    expect(t.plain()).toContain('12 个文件');
  });

  it('ignores a duplicated tool_call_start for the same id', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    const evt = { type: 'tool_call_start', toolCallId: 't1', toolName: 'read_file', arguments: '{"path":"a.ts"}' } as const;
    t.renderer.onEvent(evt);
    t.renderer.onEvent(evt);
    t.renderer.onEvent({ type: 'tool_call_result', toolCallId: 't1', toolName: 'read_file', status: 'SUCCESS', summary: 'ok' });
    t.renderer.finish(runResult({ toolCalls: [{ toolCallId: 't1', toolName: 'read_file', status: 'SUCCESS' }] }));
    await tick();
    const occurrences = t.plain().split('read_file').length - 1;
    expect(occurrences).toBe(1);
  });

  it('backfills tools that never got a result', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.finish(runResult({
      status: 'CANCELLED',
      toolCalls: [{ toolCallId: 't9', toolName: 'shell', status: 'RUNNING' }],
    }));
    await tick();
    const plain = t.plain();
    expect(plain).toContain('shell');
    expect(plain).toContain('已取消');
  });
});

describe('InkTuiRenderer status line and footer', () => {
  it('summarises the round with duration, tools and todo', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'todo_updated', todos: [{ status: 'completed' }, { status: 'pending' }] });
    t.renderer.finish(runResult({ toolCalls: [
      { toolCallId: 'a', toolName: 'x', status: 'SUCCESS' },
      { toolCallId: 'b', toolName: 'y', status: 'SUCCESS' },
    ] }));
    await tick();
    const plain = t.plain();
    expect(plain).toContain('2s');
    expect(plain).toContain('2 tools');
    expect(plain).toContain('Todo 1/2');
  });

  it('notes an empty reply so the round never looks lost', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.finish(runResult());
    await tick();
    expect(t.plain()).toContain('(无文本回复)');
  });

  it('adds a divider only when turn dividers are on', async () => {
    const dividerLine = (plain: string) => plain.split('\n').some((l) => /^─{4,}$/.test(l.trim()));

    const on = mount({ dividers: true });
    on.renderer.seedChrome();
    on.renderer.startRound();
    on.renderer.finish(runResult());
    await tick();
    expect(dividerLine(on.plain())).toBe(true);

    const off = mount({ dividers: false });
    off.renderer.seedChrome();
    off.renderer.startRound();
    off.renderer.onEvent({ type: 'content_delta', delta: 'hi\n' });
    off.renderer.finish(runResult());
    await tick();
    expect(dividerLine(off.plain())).toBe(false);
  });

  it('exposes the last round text for /copy', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'content_delta', delta: '回复正文\n' });
    t.renderer.finish(runResult());
    await tick();
    expect(t.renderer.getLastAssistantText()).toContain('回复正文');
  });
});

describe('InkTuiRenderer thinking', () => {
  it('hides thinking text unless enabled', async () => {
    const t = mount({ thinking: false });
    t.renderer.seedChrome();
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'thinking_delta', delta: '内部推理\n' });
    t.renderer.onEvent({ type: 'thinking_end' });
    await tick();
    expect(t.plain()).not.toContain('内部推理');
    expect(t.renderer.getThinking()).toBe(false);
  });

  it('shows thinking text once toggled on', async () => {
    const t = mount({ thinking: false });
    t.renderer.seedChrome();
    t.renderer.setThinking(true);
    t.renderer.startRound();
    t.renderer.onEvent({ type: 'thinking_delta', delta: '内部推理\n' });
    t.renderer.onEvent({ type: 'thinking_end' });
    await tick();
    expect(t.plain()).toContain('内部推理');
  });
});

describe('InkTuiRenderer announce vs print', () => {
  it('caps transient hints to the announce budget', async () => {
    const t = mount({ rows: 24 });
    t.renderer.seedChrome();
    for (let i = 0; i < 30; i++) t.renderer.announce(`提示 ${i}`);
    await tick();
    // 只有最近 announceRows 行留在屏幕上；提示不进转录，clearTransient 后应彻底消失
    const frame = t.frame();
    expect(frame).toContain('提示 29');
    expect(frame).not.toContain('提示 0');
    t.reset();
    t.renderer.clearTransient();
    await tick();
    expect(t.frame()).not.toContain('提示 29');
  });

  it('keeps printed output in the transcript after clearTransient', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.print('命令结果', 'ok');
    await tick();
    t.renderer.clearTransient();
    await tick();
    expect(t.plain()).toContain('命令结果');
  });

  it('records user turns in the transcript', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.noteUser('帮我改登录页');
    await tick();
    expect(t.plain()).toContain('帮我改登录页');
  });
});

describe('InkTuiRenderer clearAll', () => {
  it('clears the terminal and scrollback, then re-seeds the welcome card', async () => {
    const t = mount();
    t.renderer.seedChrome(['旧历史']);
    t.renderer.print('清屏前的内容');
    await tick();
    t.out.chunks.length = 0;
    t.handle.clearAll();
    await tick();
    const text = t.text();
    expect(text).toContain('\x1b[2J\x1b[3J\x1b[H');
    expect(t.plain()).toContain('mao-agent 测试');
    expect(t.plain()).not.toContain('清屏前的内容');
  });
});

describe('InkTuiRenderer ask flow', () => {
  it('buffers an answer that arrives before the resolver is registered', async () => {
    const t = mount();
    t.renderer.seedChrome();
    t.renderer.onEvent({
      type: 'ask_user_questions',
      requestId: 'r1',
      questions: [{ question: '继续？', options: [{ label: '是' }, { label: '否' }] }],
    });
    await tick();
    expect(t.plain()).toContain('继续？');
    t.stdin.emit('data', '1');
    await tick();
    const answers = await new Promise((resolve) => t.renderer.setAskResolver('r1', resolve));
    expect(answers).toEqual([{ question: '继续？', selectedLabels: ['是'] }]);
  });

  it('resolves a pending resolver when the user answers', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const pending = new Promise((resolve) => t.renderer.setAskResolver('r2', resolve));
    t.renderer.onEvent({
      type: 'ask_user_questions',
      requestId: 'r2',
      questions: [{ question: '选项？', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await tick();
    t.stdin.emit('data', '\x1b[B');
    t.stdin.emit('data', '\r');
    expect(await pending).toEqual([{ question: '选项？', selectedLabels: ['B'] }]);
  });

  it('delivers cancellation when the server withdraws the question', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const pending = new Promise((resolve) => t.renderer.setAskResolver('r3', resolve));
    t.renderer.onEvent({ type: 'ask_user_questions', requestId: 'r3', questions: [{ question: 'q', options: [] }] });
    t.renderer.onEvent({ type: 'ask_user_questions_cancelled', requestId: 'r3' });
    expect(await pending).toBe('cancelled');
  });

  it('ignores a duplicated ask event for the same requestId', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const q: CliEvent = {
      type: 'ask_user_questions',
      requestId: 'r4',
      questions: [{ question: '唯一问题', options: [{ label: 'A' }] }],
    };
    t.renderer.onEvent(q);
    t.renderer.onEvent(q);
    await tick();
    // 面板只显示队首，重复入队会导致答完第一个又弹一次
    t.stdin.emit('data', '1');
    await tick();
    expect(t.plain()).toContain('唯一问题');
    const answers = await new Promise((resolve) => t.renderer.setAskResolver('r4', resolve));
    expect(answers).toEqual([{ question: '唯一问题', selectedLabels: ['A'] }]);
  });
});

describe('InkTuiRenderer approval flow', () => {
  it('queues approvals FIFO so resolvers cannot overwrite each other', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const first = t.renderer.requestApproval({ toolName: 'shell', description: '第一个命令' }, '需要审批');
    const second = t.renderer.requestApproval({ toolName: 'write_file', description: '第二个命令' }, '需要审批');
    await tick();
    let plain = t.plain();
    expect(plain).toContain('第一个命令');
    expect(plain).toContain('还有 1 个待处理');

    t.stdin.emit('data', 'y');
    expect(await first).toBe('allow');
    await tick();
    plain = t.plain();
    expect(plain).toContain('第二个命令');

    t.stdin.emit('data', 'n');
    expect(await second).toBe('deny');
  });

  it('requires a second Enter for dangerous commands', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const decision = t.renderer.requestApproval(
      { toolName: 'shell', description: 'rm -rf build', dangerReason: '递归删除' },
      '需要审批',
    );
    await tick();
    t.stdin.emit('data', 'y');
    await tick();
    expect(t.plain()).toContain('再按 Enter 确认');
    t.stdin.emit('data', '\r');
    expect(await decision).toBe('allow');
  });
});

describe('InkTuiRenderer keyboard routing', () => {
  it('sends keys to the input controller when no modal is open', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const submitted: string[] = [];
    t.renderer.setInputHandlers({
      onSubmit: (text) => submitted.push(text),
      onCancel: () => undefined,
      onEscape: () => undefined,
      onExit: () => undefined,
    });
    t.stdin.emit('data', '你好');
    t.stdin.emit('data', '\r');
    await tick();
    expect(submitted).toEqual(['你好']);
  });

  it('routes keys to the modal while it is open, then back to the input', async () => {
    const t = mount();
    t.renderer.seedChrome();
    const submitted: string[] = [];
    t.renderer.setInputHandlers({
      onSubmit: (text) => submitted.push(text),
      onCancel: () => undefined,
      onEscape: () => undefined,
      onExit: () => undefined,
    });
    const decision = t.renderer.requestApproval({ toolName: 'shell', description: 'ls' }, '需要审批');
    await tick();
    t.stdin.emit('data', 'y');
    expect(await decision).toBe('allow');
    await tick();
    t.stdin.emit('data', 'hi\r');
    await tick();
    expect(submitted).toEqual(['hi']);
  });

  it('flushes a lone Esc after the escape timeout', async () => {
    const t = mount();
    t.renderer.seedChrome();
    let escaped = 0;
    t.renderer.setInputHandlers({
      onSubmit: () => undefined,
      onCancel: () => undefined,
      onEscape: () => { escaped += 1; },
      onExit: () => undefined,
    });
    t.stdin.emit('data', '\x1b');
    await tick(80);
    expect(escaped).toBe(1);
  });
});
