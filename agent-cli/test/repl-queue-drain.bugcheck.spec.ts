import { describe, expect, it, vi } from 'vitest';
import { runRepl, type ReplOptions } from '../src/repl/repl';
import type { SessionRunner } from '../src/session/session-runner';
import type { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';
import type { SessionVO } from '../src/rest/types';

/**
 * 回归测试（2026-11-07 审查 BUG-7，修复后转正，2 条用例应真实通过）。
 *
 * 原缺陷：`/resume` 切入（或启动即 attach）运行中会话后，等待期间排队的输入永不消费。
 *
 * 位置：agent-cli/src/repl/repl.ts
 *   - 排队承诺：handleSubmit —— isRunning()（= busy）期间输入入队，提示「已排队」；
 *   - 修复前唯一的排水循环在 handleSubmit 的直发分支（runOne 之后的 while），
 *     而 resumeActiveRun（启动分支与 /resume 分支共用）在 handleSubmit/runOne 之外 await，
 *     结束后无人消费队列；
 *   - 后果：等待期间排队的消息静默滞留，下一条消息提交后反而先发出旧消息（乱序）。
 *
 * 修复口径：抽出公共排水函数 drainQueuedPrompts，`/resume` 续接结束与
 * 「进入即运行中」续接结束都调用它，保证「本轮结束自动发送」的排队承诺在两条路径都兑现。
 *
 * 用例断言「正确行为」：排队消息在本轮/续接结束后自动发出（修复前两条均真实失败）。
 */
const bugIt = it;

interface Deferred {
  resolve: () => void;
  promise: Promise<void>;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

type SubmitHandlers = {
  onSubmit: (t: string) => void;
  onCancel: () => void;
  onEscape: () => void;
  onExit: () => void;
};

interface Harness {
  opts: ReplOptions;
  runPrompt: ReturnType<typeof vi.fn>;
  /** runRepl 启动后注册进渲染器的按键处理器（submit 用它模拟用户输入） */
  handlers: () => SubmitHandlers;
  onInputReady: ReturnType<typeof vi.fn>;
  hints: string[];
  /** 状态句柄：控制 isRunning / snapshotIsActive 与 waitForCurrentRun 的释放 */
  state: { busy: boolean; active: boolean; gate: Deferred | null };
  exit: () => Promise<void>;
}

function setup(startActive: boolean): Harness {
  const state = { busy: false, active: startActive, gate: null as Deferred | null };
  const hints: string[] = [];
  const runPrompt = vi.fn(async () => ({ status: 'COMPLETED' }));
  let handlers: SubmitHandlers = null as never;
  const onInputReady = vi.fn();

  const runner = {
    isRunning: () => state.busy,
    get snapshotIsActive() { return state.active; },
    // 真实 waitForCurrentRun 全程 busy=true（session-runner.ts:209-222），等待点由 gate 控制
    waitForCurrentRun: async () => {
      state.busy = true;
      try {
        if (state.gate) await state.gate.promise;
      } finally {
        state.busy = false;
      }
      return { status: 'COMPLETED' } as never;
    },
    runPrompt,
    cancel: vi.fn(async () => undefined),
    getSession: () => ({ id: 1 }),
  } as unknown as SessionRunner;

  const renderer = {
    announce: (s: string) => hints.push(s),
    print: (s: string) => hints.push(s),
    clearTransient: () => undefined,
    noteUser: () => undefined,
    startRound: () => undefined,
    setInputHandlers: (h: SubmitHandlers) => { handlers = h; },
  } as unknown as InkTuiRenderer;

  let requestExitResolve: (() => void) | null = null;

  const opts: ReplOptions = {
    runner,
    renderer,
    tuiHandle: { clearAll: () => undefined, unmount: () => undefined } as unknown as TuiHandle,
    resolveModel: async () => 7,
    onExit: async () => { requestExitResolve?.(); },
    onInputReady: () => onInputReady(),
  };

  const done = new Promise<void>((resolve) => { requestExitResolve = resolve; });

  return {
    opts,
    runPrompt,
    handlers: () => handlers,
    onInputReady,
    hints,
    state,
    exit: () => done,
  } as Harness;
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('BUGCHECK /resume 切入运行中会话后排队输入应被消费', () => {
  bugIt('启动即运行中（mao-agent resume <运行中会话>）：等待期间排队的消息在本轮结束后自动发出', async () => {
    const t = setup(true);
    t.state.gate = makeDeferred();
    void runRepl(t.opts).catch(() => undefined);
    await tick();
    expect(t.onInputReady).toHaveBeenCalled();

    // 占用方仍在执行：输入被排队
    t.handlers().onSubmit('hello');
    await tick();
    expect(t.hints.join('\n')).toContain('已排队');
    expect(t.runPrompt).not.toHaveBeenCalled();

    // 占用方执行结束 → 正确行为：队列里的消息自动发出
    t.state.gate.resolve();
    await tick();
    expect(t.runPrompt).toHaveBeenCalledWith('hello', undefined);

    // 收尾退出
    t.handlers().onExit();
    await tick();
  });

  bugIt('REPL 内 /resume 切到运行中会话：等待期间排队的消息在续接结束后自动发出', async () => {
    const t = setup(false);
    t.state.gate = makeDeferred();
    // /resume 切换后目标会话显示为运行中（switchSession 置 active）
    (t.opts as { switchSession?: unknown; listSwitchableSessions?: unknown }).switchSession = async (id: number) => {
      t.state.active = true;
      return { id, title: `会话${id}`, modelId: 9 } as SessionVO;
    };
    (t.opts as { listSwitchableSessions?: unknown }).listSwitchableSessions = async () => [];
    void runRepl(t.opts).catch(() => undefined);
    await tick();
    expect(t.onInputReady).toHaveBeenCalled();

    t.handlers().onSubmit('/resume 21');
    await tick();
    expect(t.hints.join('\n')).toContain('已切换到会话 #21');

    // 续接等待期间输入：被排队
    t.handlers().onSubmit('hello');
    await tick();
    expect(t.hints.join('\n')).toContain('已排队');
    expect(t.runPrompt).not.toHaveBeenCalled();

    // 续接结束 → 正确行为：排队消息自动发出
    t.state.gate.resolve();
    await tick();
    expect(t.runPrompt).toHaveBeenCalledWith('hello', 9);

    t.handlers().onExit();
    await tick();
  });
});
