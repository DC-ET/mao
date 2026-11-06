import { describe, expect, it, vi } from 'vitest';
import { handleSlash, type ReplOptions } from '../src/repl/repl';
import { PromptQueue } from '../src/ui/prompt-queue';
import type { SessionRunner } from '../src/session/session-runner';
import type { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';
import type { SessionVO } from '../src/rest/types';

interface Io {
  hints: string[];
  prints: Array<{ text: string; tone?: string }>;
}

const mk = (id: number, over: Partial<SessionVO> = {}): SessionVO => ({
  id,
  title: `会话${id}`,
  executionMode: 'LOCAL',
  ...over,
});

function setup(over: {
  running?: boolean;
  sessions?: SessionVO[];
  pickResult?: number | null;
  switchErr?: string;
  snapshotActive?: boolean;
  withPick?: boolean;
} = {}) {
  const io: Io = { hints: [], prints: [] };
  const listFn = vi.fn(async (_query?: string) => over.sessions ?? []);
  const switchFn = vi.fn(async (id: number) => {
    if (over.switchErr) throw new Error(over.switchErr);
    return { id, title: `会话${id}`, modelId: 9 } as SessionVO;
  });
  const pickFn = vi.fn(async (_items: SessionVO[]) => over.pickResult ?? null);
  const wait = vi.fn(async () => undefined);
  const startRound = vi.fn();

  const runner = {
    isRunning: () => Boolean(over.running),
    getSession: () => ({ id: 1 }),
    snapshotIsActive: Boolean(over.snapshotActive),
    waitForCurrentRun: wait,
  } as unknown as SessionRunner;

  const renderer = { startRound } as unknown as InkTuiRenderer;

  const opts: ReplOptions = {
    runner,
    renderer,
    tuiHandle: { clearAll: () => undefined, unmount: () => undefined } as TuiHandle,
    resolveModel: async () => 7,
    onExit: async () => undefined,
    listSwitchableSessions: listFn,
    switchSession: switchFn,
  };
  if (over.withPick !== false) opts.pickSession = pickFn;

  const queue = new PromptQueue();
  const run = (text: string) =>
    handleSlash(text, opts, queue, {
      hint: (s) => io.hints.push(s),
      print: (s, tone) => io.prints.push({ text: s, tone }),
    });
  return { io, opts, run, listFn, switchFn, pickFn, wait, startRound };
}

const allOutput = (io: Io) => [...io.hints, ...io.prints.map((p) => p.text)].join('\n');

describe('/resume 会话切换', () => {
  it('无参数：列出会话、弹面板、切换到选中项并刷新模型', async () => {
    const t = setup({ sessions: [mk(21), mk(22), mk(23)], pickResult: 22 });
    await t.run('/resume');
    expect(t.listFn).toHaveBeenCalledWith(undefined);
    expect(t.pickFn).toHaveBeenCalledTimes(1);
    expect(t.switchFn).toHaveBeenCalledWith(22);
    expect(allOutput(t.io)).toContain('已切换到会话 #22');
    expect(t.opts.modelId).toBe(9);
  });

  it('纯数字：直接切换，不拉列表、不弹面板', async () => {
    const t = setup();
    await t.run('/resume 2270');
    expect(t.listFn).not.toHaveBeenCalled();
    expect(t.pickFn).not.toHaveBeenCalled();
    expect(t.switchFn).toHaveBeenCalledWith(2270);
    expect(allOutput(t.io)).toContain('已切换到会话 #2270');
  });

  it('关键词命中 1 条：直接切换', async () => {
    const t = setup({ sessions: [mk(31, { title: '运营核对' })] });
    await t.run('/resume 运营');
    expect(t.listFn).toHaveBeenCalledWith('运营');
    expect(t.pickFn).not.toHaveBeenCalled();
    expect(t.switchFn).toHaveBeenCalledWith(31);
  });

  it('关键词命中多条：弹面板；返回 null 视为取消', async () => {
    const t = setup({ sessions: [mk(41), mk(42)], pickResult: null });
    await t.run('/resume 数据');
    expect(t.pickFn).toHaveBeenCalledTimes(1);
    expect(t.switchFn).not.toHaveBeenCalled();
    expect(allOutput(t.io)).toContain('已取消');
  });

  it('关键词 0 命中：提示且不切换', async () => {
    const t = setup({ sessions: [] });
    await t.run('/resume 不存在');
    expect(t.switchFn).not.toHaveBeenCalled();
    expect(allOutput(t.io)).toContain('没有匹配「不存在」的会话');
  });

  it('无会话时给出模式/工作区解释', async () => {
    const t = setup({ sessions: [] });
    await t.run('/resume');
    expect(allOutput(t.io)).toContain('没有可切换的会话');
  });

  it('运行中拒绝，且不触发列表/切换', async () => {
    const t = setup({ running: true, sessions: [mk(21)] });
    await t.run('/resume');
    expect(t.listFn).not.toHaveBeenCalled();
    expect(t.switchFn).not.toHaveBeenCalled();
    expect(allOutput(t.io)).toContain('还在执行');
  });

  it('切换失败时打印错误且不改 modelId', async () => {
    const t = setup({ switchErr: '无法切换：跨模式' });
    t.opts.modelId = 5;
    await t.run('/resume 999');
    expect(allOutput(t.io)).toContain('无法切换');
    expect(t.opts.modelId).toBe(5);
  });

  it('切换后目标会话运行中：续接输出（startRound + waitForCurrentRun）', async () => {
    const t = setup({ snapshotActive: true });
    await t.run('/resume 2270');
    expect(t.startRound).toHaveBeenCalled();
    expect(t.wait).toHaveBeenCalled();
    expect(allOutput(t.io)).toContain('续接当前输出');
  });

  it('无 pickSession 时打印候选列表并提示用 id', async () => {
    const t = setup({ sessions: [mk(51), mk(52)], withPick: false });
    await t.run('/resume');
    expect(t.switchFn).not.toHaveBeenCalled();
    expect(allOutput(t.io)).toContain('#51');
    expect(allOutput(t.io)).toContain('#52');
    expect(allOutput(t.io)).toContain('/resume <id>');
  });

  it('未注入切换能力时明确提示不支持', async () => {
    const io: Io = { hints: [], prints: [] };
    const opts = {
      runner: { isRunning: () => false, getSession: () => null } as unknown as SessionRunner,
      renderer: {} as unknown as InkTuiRenderer,
      tuiHandle: {} as TuiHandle,
      resolveModel: async () => 1,
      onExit: async () => undefined,
    } as ReplOptions;
    await handleSlash('/resume', opts, new PromptQueue(), {
      hint: (s) => io.hints.push(s),
      print: (s, tone) => io.prints.push({ text: s, tone }),
    });
    expect(allOutput(io)).toContain('不支持');
  });
});
