import { describe, expect, it, vi } from 'vitest';
import { handleSlash, type ReplOptions } from '../src/repl/repl';
import { PromptQueue } from '../src/ui/prompt-queue';
import type { SessionRunner } from '../src/session/session-runner';
import type { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';

interface Io {
  hints: string[];
  prints: Array<{ text: string; tone?: string }>;
}

function setup(over: {
  running?: boolean;
  todos?: Array<{ status?: string; content?: string }>;
  context?: { estimated?: number; actual?: number };
  session?: Record<string, unknown>;
  lastAssistant?: string;
  verbose?: boolean;
  thinking?: boolean;
  resolveModel?: (spec: string) => Promise<number>;
} = {}) {
  const io: Io = { hints: [], prints: [] };
  const state = { verbose: over.verbose ?? false, thinking: over.thinking ?? false };
  const cancel = vi.fn(async () => undefined);
  const clearAll = vi.fn();

  const runner = {
    isRunning: () => Boolean(over.running),
    cancel,
    getTodos: () => over.todos ?? [],
    getContext: () => over.context ?? {},
    getSession: () => over.session ?? { id: 11, agentName: 'A', modelName: 'M', workspace: '/w', phase: 'IDLE' },
  } as unknown as SessionRunner;

  const renderer = {
    getVerboseTools: () => state.verbose,
    setVerboseTools: (v: boolean) => { state.verbose = v; },
    getThinking: () => state.thinking,
    setThinking: (v: boolean) => { state.thinking = v; },
    getLastAssistantText: () => over.lastAssistant ?? '',
  } as unknown as InkTuiRenderer;

  const opts: ReplOptions = {
    runner,
    renderer,
    tuiHandle: { clearAll, unmount: () => undefined } as TuiHandle,
    resolveModel: over.resolveModel ?? (async () => 7),
    onExit: async () => undefined,
  };
  const queue = new PromptQueue();
  const run = (text: string) => handleSlash(text, opts, queue, {
    hint: (s) => io.hints.push(s),
    print: (s, tone) => io.prints.push({ text: s, tone }),
  });
  return { io, opts, queue, run, state, cancel, clearAll };
}

const allOutput = (io: Io) => [...io.hints, ...io.prints.map((p) => p.text)].join('\n');

describe('handleSlash unknown commands', () => {
  it('suggests a near match instead of sending it to the agent', async () => {
    const t = setup();
    await t.run('/hel');
    expect(t.io.prints[0].tone).toBe('warn');
    expect(t.io.prints[0].text).toContain('/help');
  });

  it('points at /help when nothing is close', async () => {
    const t = setup();
    await t.run('/zzz');
    expect(t.io.prints[0].text).toContain('输入 /help');
  });
});

describe('handleSlash exit and cancel', () => {
  it('/exit and /quit both request exit', async () => {
    expect(await setup().run('/exit')).toBe('exit');
    expect(await setup().run('/quit')).toBe('exit');
  });

  it('/exit cancels a running task first', async () => {
    const t = setup({ running: true });
    expect(await t.run('/exit')).toBe('exit');
    expect(t.cancel).toHaveBeenCalled();
  });

  it('/cancel says so when idle instead of sending a no-op cancel', async () => {
    const t = setup({ running: false });
    await t.run('/cancel');
    expect(t.cancel).not.toHaveBeenCalled();
    expect(t.io.hints[0]).toContain('没有正在执行');
  });

  it('/cancel cancels and clears the queue while running', async () => {
    const t = setup({ running: true });
    t.queue.push('排队的一条');
    await t.run('/cancel');
    expect(t.cancel).toHaveBeenCalled();
    expect(t.queue.length).toBe(0);
  });
});

describe('handleSlash toggles', () => {
  it('/verbose flips the tool output setting', async () => {
    const t = setup({ verbose: false });
    await t.run('/verbose');
    expect(t.state.verbose).toBe(true);
    await t.run('/verbose');
    expect(t.state.verbose).toBe(false);
  });

  it('/thinking flips the thinking setting', async () => {
    const t = setup({ thinking: false });
    await t.run('/thinking');
    expect(t.state.thinking).toBe(true);
    expect(t.io.hints[0]).toContain('展开');
  });

  it('/clear asks the TUI for a real screen clear', async () => {
    const t = setup();
    await t.run('/clear');
    expect(t.clearAll).toHaveBeenCalled();
  });
});

describe('handleSlash queue', () => {
  it('/queue lists pending prompts', async () => {
    const t = setup();
    t.queue.push('第一条');
    t.queue.push('第二条');
    await t.run('/queue');
    expect(t.io.prints[0].text).toBe('1. 第一条\n2. 第二条');
  });

  it('/queue reports an empty queue', async () => {
    const t = setup();
    await t.run('/queue');
    expect(t.io.hints[0]).toContain('队列为空');
  });

  it('/queue clear empties it', async () => {
    const t = setup();
    t.queue.push('x');
    await t.run('/queue clear');
    expect(t.queue.length).toBe(0);
  });

  it('/queue rejects an unknown argument', async () => {
    const t = setup();
    await t.run('/queue nope');
    expect(t.io.prints[0].tone).toBe('warn');
    expect(t.io.prints[0].text).toContain('只支持 clear');
  });
});

describe('handleSlash info commands', () => {
  it('/help lists the slash commands', async () => {
    const t = setup();
    await t.run('/help');
    expect(allOutput(t.io)).toContain('/model');
  });

  it('/session prints the session identity', async () => {
    const t = setup();
    await t.run('/session');
    const text = t.io.prints[0].text;
    expect(text).toContain('sessionId=11');
    expect(text).toContain('workspace=/w');
  });

  it('/todo prints items or says there are none', async () => {
    const empty = setup();
    await empty.run('/todo');
    expect(empty.io.hints[0]).toContain('暂无 Todo');

    const some = setup({ todos: [{ status: 'completed', content: '写测试' }] });
    await some.run('/todo');
    expect(some.io.prints[0].text).toBe('- [completed] 写测试');
  });

  it('/context prints usage and warns near the limit', async () => {
    const low = setup({ context: { estimated: 1000, actual: 900 }, session: { contextWindowTokens: 100000 } });
    await low.run('/context');
    expect(low.io.prints[0].text).toContain('estimated=1000');
    expect(low.io.prints[0].text).not.toContain('接近上限');

    const high = setup({ context: { estimated: 90000, actual: 90000 }, session: { contextWindowTokens: 100000 } });
    await high.run('/context');
    expect(high.io.prints[0].text).toContain('接近上限');
  });

  it('/agent explains that switching needs a new process', async () => {
    const t = setup();
    await t.run('/agent');
    expect(t.io.prints[0].text).toContain('--agent');
  });
});

describe('handleSlash /model', () => {
  it('shows the current model without an argument', async () => {
    const t = setup({ session: { modelName: 'gpt-4o' } });
    await t.run('/model');
    expect(t.io.prints[0].text).toContain('gpt-4o');
  });

  it('switches on success and records the id for the next prompt', async () => {
    const t = setup({ resolveModel: async () => 42 });
    await t.run('/model gpt-4o');
    expect(t.opts.modelId).toBe(42);
    expect(t.io.hints[0]).toContain('id=42');
  });

  it('reports a resolve failure as an error instead of throwing', async () => {
    const t = setup({ resolveModel: async () => { throw new Error('找不到模型 nope'); } });
    await t.run('/model nope');
    expect(t.io.prints[0].tone).toBe('err');
    expect(t.io.prints[0].text).toContain('找不到模型');
    expect(t.opts.modelId).toBeUndefined();
  });
});

describe('handleSlash /copy', () => {
  it('says there is nothing to copy on an empty transcript', async () => {
    const t = setup({ lastAssistant: '   ' });
    await t.run('/copy');
    expect(t.io.hints[0]).toContain('没有可复制');
  });

  it('falls back to printing the reply when no clipboard command exists', async () => {
    const t = setup({ lastAssistant: '上一回合回复正文' });
    await t.run('/copy');
    expect(allOutput(t.io)).toContain('上一回合回复正文');
  });
});
