import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../session/ws/ws-streaming-event-listener.js', () => {
  class WsStreamingEventListener {
    readonly marker = 'ws-listener';
    constructor(
      public deps: unknown,
      public sessionId: number,
      public userId: number,
      public executionId: string,
      public supportsVision: boolean,
    ) {}
  }
  return { WsStreamingEventListener };
});

import type { AgentEventListener } from './agent-event-listener.js';
import { CompositeAgentEventListener } from './composite-agent-event-listener.js';
import { CrashRecoveryRunner, type RecoveryExtraListener } from './crash-recovery-runner.js';

interface RunnerOptions {
  cancelled?: boolean;
  executeError?: Error;
}

function makeRunner(
  extra?: (sessionId: number, userId: number | null, executionId: string) => Promise<RecoveryExtraListener | null>,
  options: RunnerOptions = {},
  runtimeDir = '/tmp/mao-crash-recovery-spec-runtime-missing',
) {
  const pending: Promise<void>[] = [];
  const session = { id: 7, userId: 42, sessionType: 'DEFAULT', phase: 'RUNNING', modelId: null };
  const sessionMapper = {
    selectByPhase: vi.fn().mockResolvedValue([session]),
    selectById: vi.fn().mockResolvedValue(session),
  };
  const sessionService = {
    cleanupIncompleteTail: vi.fn().mockResolvedValue(0),
    updatePhase: vi.fn().mockResolvedValue(undefined),
  };
  const taskTerminalService = { finishExecution: vi.fn().mockResolvedValue(undefined) };
  const harnessService = {
    execute: options.executeError != null
      ? vi.fn().mockRejectedValue(options.executeError)
      : vi.fn().mockResolvedValue(undefined),
  };
  const agentLoop = {
    registerCancelFlag: vi.fn().mockReturnValue({ get: () => options.cancelled === true, set: () => undefined }),
    removeCancelFlag: vi.fn(),
  };
  const onExecutionFinished = vi.fn().mockResolvedValue(undefined) as (
    sessionId: number, userId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED',
  ) => Promise<void>;
  const runner = new CrashRecoveryRunner(
    sessionMapper as never,
    sessionService as never,
    taskTerminalService as never,
    harnessService as never,
    agentLoop as never,
    { send: vi.fn() } as never,
    {} as never,
    { clear: vi.fn() } as never,
    { selectBySessionId: vi.fn().mockResolvedValue([]) } as never,
    { selectById: vi.fn().mockResolvedValue(null), selectDefault: vi.fn().mockResolvedValue(null) } as never,
    runtimeDir,
    { submit: (fn: () => Promise<void>) => { pending.push(fn()); } },
    onExecutionFinished,
    undefined,
    extra,
  );
  return { runner, taskTerminalService, harnessService, pending, onExecutionFinished };
}

describe('CrashRecoveryRunner.createExtraListeners', () => {
  it('composesExtraListenerWithWsListener', async () => {
    const extra: AgentEventListener = { onContentDelta: () => {} };
    const { runner, harnessService, pending } = makeRunner(async () => extra);
    await runner.run();
    await Promise.all(pending);
    const listener = harnessService.execute.mock.calls[0][2] as CompositeAgentEventListener;
    expect(listener).toBeInstanceOf(CompositeAgentEventListener);
    const inner = (listener as unknown as { listeners: AgentEventListener[] }).listeners;
    expect(inner.some((l) => (l as { marker?: string }).marker === 'ws-listener')).toBe(true);
    expect(inner).toContain(extra);
  });

  it('nullExtraKeepsBareWsListener', async () => {
    const { runner, harnessService, pending } = makeRunner(async () => null);
    await runner.run();
    await Promise.all(pending);
    expect((harnessService.execute.mock.calls[0][2] as { marker?: string }).marker).toBe('ws-listener');
  });

  it('extraFactoryFailureDoesNotBlockRecovery', async () => {
    const { runner, harnessService, taskTerminalService, pending } = makeRunner(async () => {
      throw new Error('boom');
    });
    await runner.run();
    await Promise.all(pending);
    expect((harnessService.execute.mock.calls[0][2] as { marker?: string }).marker).toBe('ws-listener');
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(7, 42, 'COMPLETED', expect.any(String));
  });

  it('executionFailureNotifiesExtraOnErrorAndMarksFailed', async () => {
    const onError = vi.fn();
    const extra: RecoveryExtraListener = { onContentDelta: () => {}, onError };
    const { runner, taskTerminalService, pending } = makeRunner(async () => extra, { executeError: new Error('llm down') });
    await runner.run();
    await Promise.all(pending);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(7, 42, 'FAILED', expect.any(String), 'llm down');
  });

  it('cancelledRecoveryNotifiesExtraCancelAndMarksCancelled', async () => {
    const cancel = vi.fn().mockResolvedValue(true);
    const extra: RecoveryExtraListener = { onContentDelta: () => {}, onError: () => {}, cancel };
    const { runner, taskTerminalService, pending } = makeRunner(async () => extra, { cancelled: true });
    await runner.run();
    await Promise.all(pending);
    expect(cancel).toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(7, 42, 'CANCELLED', expect.any(String));
  });

  it('onExecutionFinishedReceivesPhaseFailedWhenRecoveryFails', async () => {
    const { runner, onExecutionFinished, pending } = makeRunner(undefined, { executeError: new Error('llm down') });
    await runner.run();
    await Promise.all(pending);
    expect(onExecutionFinished).toHaveBeenCalledWith(7, 42, 'FAILED');
  });

  it('onExecutionFinishedReceivesPhaseCompletedWhenRecoverySucceeds', async () => {
    const { runner, onExecutionFinished, pending } = makeRunner();
    await runner.run();
    await Promise.all(pending);
    expect(onExecutionFinished).toHaveBeenCalledWith(7, 42, 'COMPLETED');
  });
});

describe('CrashRecoveryRunner deferred rescan', () => {
  /** 写入 deploy.lock（starting 状态）模拟蓝绿部署窗口。 */
  function writeDeployLock(dir: string, ageSec: number): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
      startedAt: Math.floor(Date.now() / 1000) - ageSec,
      oldPort: 9080,
      newPort: 9081,
      status: 'starting',
      drainSec: 60,
    }));
  }

  function makeDeferredRunner(runtimeDir: string, scanSequence: number[][]) {
    const pending: Promise<void>[] = [];
    // collectCandidates 每轮扫描调用 selectByPhase 两次（RUNNING + RESUMING），
    // 这里按「轮」推进序列：每轮两次调用消费同一个 ids 元素。
    let round = 0;
    const sessionMapper = {
      selectByPhase: vi.fn()
        .mockImplementation(async (phase: string) => {
          if (phase === 'RESUMING') return [];
          const ids = scanSequence[Math.min(round, scanSequence.length - 1)] ?? [];
          round++;
          return ids.map((id) => ({ id, userId: 42, sessionType: 'DEFAULT', phase, modelId: null }));
        }),
      selectById: vi.fn().mockImplementation(async (id: number) =>
        ({ id, userId: 42, sessionType: 'DEFAULT', phase: 'RUNNING', modelId: null })),
    };
    const runner = new CrashRecoveryRunner(
      sessionMapper as never,
      { cleanupIncompleteTail: vi.fn().mockResolvedValue(0), updatePhase: vi.fn().mockResolvedValue(undefined) } as never,
      { finishExecution: vi.fn().mockResolvedValue(undefined) } as never,
      { execute: vi.fn().mockResolvedValue(undefined) } as never,
      { registerCancelFlag: vi.fn().mockReturnValue({ get: () => false }), removeCancelFlag: vi.fn() } as never,
      { send: vi.fn() } as never,
      {} as never,
      { clear: vi.fn() } as never,
      { selectBySessionId: vi.fn().mockResolvedValue([]) } as never,
      { selectById: vi.fn().mockResolvedValue(null), selectDefault: vi.fn().mockResolvedValue(null) } as never,
      runtimeDir,
      { submit: (fn: () => Promise<void>) => { pending.push(fn()); } },
      vi.fn().mockResolvedValue(undefined),
      undefined,
      undefined,
    );
    return { runner, sessionMapper, pending };
  }

  it('deferredRescanRecoversSessionsCreatedAfterInitialScan', async () => {
    vi.useFakeTimers();
    try {
      const dir = join(tmpdir(), `mao-crash-rescan-${Date.now()}`);
      writeDeployLock(dir, 0);
      // 初始扫描：仅会话 1；补扫 pass：出现新会话 2（部署窗口内新建、随旧实例死亡）。
      const { runner, sessionMapper, pending } = makeDeferredRunner(dir, [[1], [1, 2]]);
      await runner.run();
      // 快照重放（延迟恢复首次 pass）：只恢复快照里的会话 1。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessionMapper.selectById).not.toHaveBeenCalledWith(2);
      // 全库补扫（快照重放后 RESCAN_DELAY_SEC 触发）：恢复漏掉的会话 2。
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(1);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(2);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescanDoesNotDoubleRecoverSnapshotCandidates', async () => {
    vi.useFakeTimers();
    try {
      const dir = join(tmpdir(), `mao-crash-rescan-dedup-${Date.now()}`);
      writeDeployLock(dir, 0);
      // 补扫 pass 仍看到会话 1（快照里已有）：首次恢复后 phase 已是 COMPLETED，
      // 恢复前重查会跳过，不会重复恢复。
      const pending: Promise<void>[] = [];
      const sessionMapper = {
        selectByPhase: vi.fn().mockImplementation(async (phase: string) =>
          phase === 'RUNNING'
            ? [{ id: 1, userId: 42, sessionType: 'DEFAULT', phase, modelId: null }]
            : []),
        selectById: vi.fn()
          .mockResolvedValueOnce({ id: 1, userId: 42, sessionType: 'DEFAULT', phase: 'RUNNING', modelId: null })
          .mockResolvedValue({ id: 1, userId: 42, sessionType: 'DEFAULT', phase: 'COMPLETED', modelId: null }),
      };
      const harnessExecute = vi.fn().mockResolvedValue(undefined);
      const runner = new CrashRecoveryRunner(
        sessionMapper as never,
        { cleanupIncompleteTail: vi.fn().mockResolvedValue(0), updatePhase: vi.fn().mockResolvedValue(undefined) } as never,
        { finishExecution: vi.fn().mockResolvedValue(undefined) } as never,
        { execute: harnessExecute } as never,
        { registerCancelFlag: vi.fn().mockReturnValue({ get: () => false }), removeCancelFlag: vi.fn() } as never,
        { send: vi.fn() } as never,
        {} as never,
        { clear: vi.fn() } as never,
        { selectBySessionId: vi.fn().mockResolvedValue([]) } as never,
        { selectById: vi.fn().mockResolvedValue(null), selectDefault: vi.fn().mockResolvedValue(null) } as never,
        dir,
        { submit: (fn: () => Promise<void>) => { pending.push(fn()); } },
      );
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all(pending);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescanSkipsSessionRecoveredMeanwhile', async () => {
    vi.useFakeTimers();
    try {
      const dir = join(tmpdir(), `mao-crash-rescan-terminal-${Date.now()}`);
      writeDeployLock(dir, 0);
      // 补扫发现会话 2，但恢复前重查时已进入终态（如用户手动续跑完成）——跳过。
      const pending: Promise<void>[] = [];
      let round = 0;
      const sessionMapper = {
        selectByPhase: vi.fn().mockImplementation(async (phase: string) => {
          if (phase !== 'RUNNING') return [];
          const ids = round === 0 ? [1] : [1, 2];
          round++;
          return ids.map((id) => ({ id, userId: 42, sessionType: 'DEFAULT', phase, modelId: null }));
        }),
        // 首次恢复会话 1 正常；补扫发现会话 2 重查时已是终态 → 跳过。
        selectById: vi.fn()
          .mockResolvedValueOnce({ id: 1, userId: 42, sessionType: 'DEFAULT', phase: 'RUNNING', modelId: null })
          .mockResolvedValueOnce({ id: 2, userId: 42, sessionType: 'DEFAULT', phase: 'COMPLETED', modelId: null }),
      };
      const harnessExecute = vi.fn().mockResolvedValue(undefined);
      const runner = new CrashRecoveryRunner(
        sessionMapper as never,
        { cleanupIncompleteTail: vi.fn().mockResolvedValue(0), updatePhase: vi.fn().mockResolvedValue(undefined) } as never,
        { finishExecution: vi.fn().mockResolvedValue(undefined) } as never,
        { execute: harnessExecute } as never,
        { registerCancelFlag: vi.fn().mockReturnValue({ get: () => false }), removeCancelFlag: vi.fn() } as never,
        { send: vi.fn() } as never,
        {} as never,
        { clear: vi.fn() } as never,
        { selectBySessionId: vi.fn().mockResolvedValue([]) } as never,
        { selectById: vi.fn().mockResolvedValue(null), selectDefault: vi.fn().mockResolvedValue(null) } as never,
        dir,
        { submit: (fn: () => Promise<void>) => { pending.push(fn()); } },
      );
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(2);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescanDoesNotDoubleRunSessionStillRecovering', async () => {
    vi.useFakeTimers();
    try {
      const dir = join(tmpdir(), `mao-crash-rescan-inflight-${Date.now()}`);
      writeDeployLock(dir, 0);
      // 首轮恢复仍在执行（harness 长时挂起）时补扫再次扫到同一会话：
      // 此时 DB phase 已被恢复流程写回 RUNNING，只靠 phase 重查无法区分「崩溃遗留」，
      // 必须靠 in-flight 去重拦住，否则同一会话并发跑两次执行。
      const pending: Promise<void>[] = [];
      const sessionMapper = {
        selectByPhase: vi.fn().mockImplementation(async (phase: string) =>
          phase === 'RUNNING'
            ? [{ id: 1, userId: 42, sessionType: 'DEFAULT', phase, modelId: null }]
            : []),
        selectById: vi.fn().mockResolvedValue({ id: 1, userId: 42, sessionType: 'DEFAULT', phase: 'RUNNING', modelId: null }),
      };
      let releaseExecute: (() => void) | null = null;
      const harnessExecute = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { releaseExecute = resolve; }));
      const runner = new CrashRecoveryRunner(
        sessionMapper as never,
        { cleanupIncompleteTail: vi.fn().mockResolvedValue(0), updatePhase: vi.fn().mockResolvedValue(undefined) } as never,
        { finishExecution: vi.fn().mockResolvedValue(undefined) } as never,
        { execute: harnessExecute } as never,
        { registerCancelFlag: vi.fn().mockReturnValue({ get: () => false }), removeCancelFlag: vi.fn() } as never,
        { send: vi.fn() } as never,
        {} as never,
        { clear: vi.fn() } as never,
        { selectBySessionId: vi.fn().mockResolvedValue([]) } as never,
        { selectById: vi.fn().mockResolvedValue(null), selectDefault: vi.fn().mockResolvedValue(null) } as never,
        dir,
        { submit: (fn: () => Promise<void>) => { pending.push(fn()); } },
      );
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
      releaseExecute?.();
      await Promise.all(pending);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
