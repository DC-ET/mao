import { describe, expect, it, vi } from 'vitest';
import { runRepl, type ReplOptions } from '../src/repl/repl';
import type { SessionRunner } from '../src/session/session-runner';
import type { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';
import type { SessionVO } from '../src/rest/types';

/**
 * BUGCHECK（2026-11-07 逻辑 BUG 审查，详见 docs/code-review/2026-11-07-logic-bug-review-01.md BUG-7）。
 *
 * BUG：`/resume` 切入（或启动即 attach）运行中会话后，等待期间排队的输入永不消费。
 *
 * 位置：agent-cli/src/repl/repl.ts
 *   - 排队承诺：handleSubmit :120-127 —— isRunning()（= busy）期间输入入队，
 *     提示「已排队（第 n 条）」（/help 语义：本轮结束自动发送）；
 *   - 唯一的排水循环在 handleSubmit 的直发分支 :130-142（runOne 之后 while 队列）；
 *   - 而 resumeActiveRun :190-198（启动分支 :163-169 与 /resume 分支 :360-362 共用）
 *     await waitForCurrentRun 结束后直接返回——两条路径结束后都无人消费队列。
 *
 * 触发（一级路径）：`mao-agent resume <运行中会话>` 或 REPL 内 `/resume` 切到 RUNNING 会话
 * （752b6ebf 明确支持），等待期间输入一条消息 → 占用方执行结束后消息静默滞留；
 * 下一条消息提交后 drain 循环反而把滞留旧消息先行发出（乱序），全程无提示。
 *
 * 验证口径：用例断言「正确行为」（排队消息在本轮结束后自动发出），当前实现必然失败。
 * 默认 it.fails 固化（CI 绿）；把顶部 `const bugIt = it.fails` 改成 `const bugIt = it`
 * 再运行即得真实失败：
 *
 *   cd agent-cli
 *   sed -i '' 's/^const bugIt = it.fails$/const bugIt = it/' test/repl-queue-drain.bugcheck.spec.ts
 *   npx vitest run test/repl-queue-drain.bugcheck.spec.ts
 *   sed -i '' 's/^const bugIt = it$/const bugIt = it.fails/' test/repl-queue-drain.bugcheck.spec.ts
 */
const bugIt = it.fails;

interface Deferred {
  resolve: () => void;
  promise: Promise<void>;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

interface Harness {
  opts: ReplOptions;
  runPrompt: ReturnType<typeof vi.fn>;
  handlers: { onSubmit: (t: string) => void; onCancel: () => void; onEscape: () => void; onExit: () => void };
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
  let handlers: Harness['handlers'] = null as never;
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
    setInputHandlers: (h: Harness['handlers']) => { handlers = h; },
  } as unknown as InkTuiRenderer;

  const exitPromise = new Promise<void>((resolve) => {
    var _resolve = resolve;
  });
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
