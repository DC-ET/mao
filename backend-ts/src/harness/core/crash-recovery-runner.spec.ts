import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';

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
    getMessages: vi.fn().mockResolvedValue([]),
    extractVisibleText: (content: string | null) => content,
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
  const registry = { send: vi.fn() };
  const onExecutionFinished = vi.fn().mockResolvedValue(undefined) as (
    sessionId: number, userId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED',
  ) => Promise<void>;
  const runner = new CrashRecoveryRunner(
    sessionMapper as never,
    sessionService as never,
    taskTerminalService as never,
    harnessService as never,
    agentLoop as never,
    registry as never,
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
  return { runner, registry, taskTerminalService, harnessService, pending, onExecutionFinished, sessionService };
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

  it('successfulRecoveryNotifiesExtraCompleteWithLatestAssistantReply', async () => {
    const complete = vi.fn().mockResolvedValue(true);
    const extra: RecoveryExtraListener = { onContentDelta: () => {}, onError: () => {}, complete };
    const { runner, taskTerminalService, pending, sessionService } = makeRunner(async () => extra);
    sessionService.getMessages.mockResolvedValue([
      { role: 'USER', content: '请继续' },
      { role: 'ASSISTANT', content: '最终回复' },
    ]);
    await runner.run();
    await Promise.all(pending);
    expect(complete).toHaveBeenCalledWith('最终回复');
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(7, 42, 'COMPLETED', expect.any(String));
  });

  it('successfulRecoveryCompleteFallsBackWhenNoAssistantReply', async () => {
    const complete = vi.fn().mockResolvedValue(true);
    const extra: RecoveryExtraListener = { onContentDelta: () => {}, onError: () => {}, complete };
    const { runner, pending } = makeRunner(async () => extra);
    await runner.run();
    await Promise.all(pending);
    expect(complete).toHaveBeenCalledWith('任务已完成。');
  });

  it('executionFailureNotifiesExtraFailAndMarksFailed', async () => {
    const fail = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();
    const extra: RecoveryExtraListener = { onContentDelta: () => {}, onError, fail };
    const { runner, taskTerminalService, pending } = makeRunner(async () => extra, { executeError: new Error('llm down') });
    await runner.run();
    await Promise.all(pending);
    expect(fail).toHaveBeenCalledWith('llm down');
    expect(onError).not.toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(7, 42, 'FAILED', expect.any(String), 'llm down');
  });

  it('executionFailureFallsBackToOnErrorWhenFailIsAbsent', async () => {
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

  it('runningNotificationsCarryTheNewExecutionIdSoReconnectClientsCanRebind', async () => {
    const { runner, registry, taskTerminalService, pending } = makeRunner();
    await runner.run();
    await Promise.all(pending);
    const runningEvents = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .filter((e) => e.type === 'session_status' && e.data?.phase === 'RUNNING');
    expect(runningEvents.length).toBeGreaterThan(0);
    // 恢复执行换了新 executionId，RUNNING 通知必须带上它：前端据此重绑 activeExecutionId，
    // 否则恢复执行的流式帧会被 isStaleExecution 当陈旧帧全部丢弃（进度永久卡住）。
    const executionId = String(runningEvents[0]!.data!.executionId ?? '');
    expect(executionId).not.toBe('');
    for (const e of runningEvents) expect(e.data?.executionId).toBe(executionId);
    // 与终态收敛使用的是同一个 executionId
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(7, 42, 'COMPLETED', executionId);
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

  function makeDeferredRunner(
    runtimeDir: string,
    scanSequence: number[][],
    locallyActiveIds: number[] = [],
    selfPort = 9081,
  ) {
    const pending: Promise<void>[] = [];
    // 本实例承接流量（active-backend-port = 自身端口），否则延迟恢复会被部署闸门推迟。
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'active-backend-port'), String(selfPort));
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
      (sessionId: number) => locallyActiveIds.includes(sessionId),
      selfPort,
    );
    return { runner, sessionMapper, pending };
  }

  it('deferredRescanRecoversSessionsCreatedAfterInitialScan', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-');
      writeDeployLock(dir, 0);
      // 初始扫描：仅会话 1；补扫 pass：出现新会话 2（部署窗口内新建、随旧实例死亡）。
      const { runner, sessionMapper, pending } = makeDeferredRunner(dir, [[1], [1, 2]]);
      await runner.run();
      // 部署窗口内（drainSec 60s + 60s 余量）不得执行延迟恢复：快照重放不做静默校验，
      // 此时旧实例可能仍在跑这些会话，抢跑会双跑。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessionMapper.selectById).not.toHaveBeenCalledWith(1);
      expect(sessionMapper.selectById).not.toHaveBeenCalledWith(2);
      // 超过排空窗口后：快照重放恢复会话 1，随后 RESCAN_DELAY_SEC 的全库补扫恢复会话 2。
      await vi.advanceTimersByTimeAsync(160_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(1);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deferredRescanRunsWhenInitialScanFindsNothing', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-empty-');
      writeDeployLock(dir, 0);
      // 初始扫描为空：会话在蓝绿部署窗口内创建于旧实例、随旧实例 drain 被 kill，
      // 新实例启动时刻 DB 里还没有这条 RUNNING 记录。只有延迟恢复的全库补扫能兜住它，
      // 否则会话永久停在 RUNNING（飞书进度卡卡在「正在处理」）。
      const { runner, sessionMapper, pending } = makeDeferredRunner(dir, [[], [2]]);
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessionMapper.selectById).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(160_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('noDeferredRescanWhenDeployLockIsNotRecent', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-nodeploy-');
      // 普通重启（无 deploy.lock）：初始候选为空即收工，不安排额外的全库补扫。
      const { runner, sessionMapper, pending } = makeDeferredRunner(dir, [[], [2]]);
      await runner.run();
      await vi.advanceTimersByTimeAsync(120_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deferredRescanSkipsSessionsRunningLocally', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-local-');
      writeDeployLock(dir, 0);
      // 补扫同时扫到崩溃遗留的会话 2 与本实例正在执行的会话 3：只恢复前者，
      // 否则会对正在跑的执行并发重跑同一会话。
      const { runner, sessionMapper, pending } = makeDeferredRunner(dir, [[], [2, 3]], [3]);
      await runner.run();
      // 等过部署窗口（drainSec 60s + 60s 余量）再断言，避免命中"部署中推迟"分支。
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(160_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(2);
      expect(sessionMapper.selectById).not.toHaveBeenCalledWith(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescanDoesNotDoubleRecoverSnapshotCandidates', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-dedup-');
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
        undefined,
        undefined,
        undefined,
        undefined,
        9081,
      );
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(160_000);
      await Promise.all(pending);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescanSkipsSessionRecoveredMeanwhile', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-terminal-');
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
        undefined,
        undefined,
        undefined,
        undefined,
        9081,
      );
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(160_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(2);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescanDoesNotDoubleRunSessionStillRecovering', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-crash-rescan-inflight-');
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
        undefined,
        undefined,
        undefined,
        undefined,
        9081,
      );
      await runner.run();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(160_000);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
      releaseExecute?.();
      await Promise.all(pending);
      expect(harnessExecute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CrashRecoveryRunner orphan sweep', () => {
  /** 本地时区 `yyyy-MM-dd HH:mm:ss`（与 parseSqlDateTime 的解析口径一致）。 */
  function sqlTime(offsetMs: number): string {
    const d = new Date(Date.now() - offsetMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function writeActivePort(dir: string, port: number): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'active-backend-port'), String(port));
  }

  function writeLock(dir: string, status: string, ageSec = 5): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
      startedAt: Math.floor(Date.now() / 1000) - ageSec,
      oldPort: 9080,
      newPort: 9081,
      status,
      drainSec: 60,
    }));
  }

  interface SweepSession { id: number; phase: string; lastActivityAt?: string | null }

  function makeSweepRunner(options: {
    runtimeDir: string;
    selfPort?: number;
    sessions: SweepSession[];
    locallyActiveIds?: number[];
    blockedIds?: number[];
  }) {
    const pending: Promise<void>[] = [];
    const sessionMapper = {
      selectByPhase: vi.fn(async (phase: string) =>
        options.sessions
          .filter((s) => s.phase === phase)
          .map((s) => ({
            id: s.id, userId: 42, sessionType: 'DEFAULT', phase, modelId: null,
            lastActivityAt: s.lastActivityAt ?? null,
          }))),
      selectById: vi.fn(async (id: number) => {
        const found = options.sessions.find((s) => s.id === id);
        if (found == null) return null;
        return {
          id, userId: 42, sessionType: 'DEFAULT', phase: found.phase, modelId: null,
          lastActivityAt: found.lastActivityAt ?? null,
        };
      }),
    };
    const harnessExecute = vi.fn().mockResolvedValue(undefined);
    const coordinator = { listBlockedSessionIds: vi.fn(async () => new Set(options.blockedIds ?? [])) };
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
      options.runtimeDir,
      { submit: (fn: () => Promise<void>) => { pending.push(fn()); } },
      vi.fn().mockResolvedValue(undefined),
      coordinator as never,
      undefined,
      (sessionId: number) => (options.locallyActiveIds ?? []).includes(sessionId),
      options.selfPort,
    );
    return { runner, pending, sessionMapper, harnessExecute, coordinator };
  }

  it('skipsSweepWhenThisInstanceIsNotServingTraffic', async () => {
    const dir = useTmpDir('mao-sweep-inactive-');
    writeActivePort(dir, 9080);
    const { runner, sessionMapper } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [{ id: 5, phase: 'RESUMING' }],
    });

    await runner.sweepOrphans();

    expect(sessionMapper.selectById).not.toHaveBeenCalled();
  });

  it('skipsSweepWhileDeployIsInFlight', async () => {
    const dir = useTmpDir('mao-sweep-deploy-');
    writeActivePort(dir, 9081);
    // 排空中的旧实例仍在跑会话，抢过来会并发重复执行。
    writeLock(dir, 'switched');
    const { runner, sessionMapper } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [{ id: 5, phase: 'RESUMING' }],
    });

    await runner.sweepOrphans();

    expect(sessionMapper.selectById).not.toHaveBeenCalled();
  });

  it('skipsFreshSessionsButRecoversQuietResumingAndSilentRunning', async () => {
    const dir = useTmpDir('mao-sweep-stale-');
    writeActivePort(dir, 9081);
    writeLock(dir, 'drained');
    const { runner, sessionMapper, pending } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [
        // RUNNING 且刚有心跳：无法与"别的实例正在跑"区分，不能抢。
        { id: 5, phase: 'RUNNING', lastActivityAt: sqlTime(5_000) },
        // RESUMING 刚被写入：标记方可能仍在收尾（其心跳还会刷新时间戳），不能抢。
        { id: 6, phase: 'RESUMING', lastActivityAt: sqlTime(5_000) },
        // RESUMING 已静默超过阈值：标记方确实没了，立即恢复。
        { id: 7, phase: 'RESUMING', lastActivityAt: sqlTime(60_000) },
        // RUNNING 静默超过阈值：孤儿。
        { id: 8, phase: 'RUNNING', lastActivityAt: sqlTime(10 * 60_000) },
      ],
    });

    await runner.sweepOrphans();
    await Promise.all(pending);

    expect(sessionMapper.selectById).toHaveBeenCalledWith(7);
    expect(sessionMapper.selectById).toHaveBeenCalledWith(8);
    expect(sessionMapper.selectById).not.toHaveBeenCalledWith(5);
    expect(sessionMapper.selectById).not.toHaveBeenCalledWith(6);
  });

  it('recoversRunningSessionThatStayedSilentPastThreshold', async () => {
    const dir = useTmpDir('mao-sweep-orphan-');
    writeActivePort(dir, 9081);
    const { runner, sessionMapper, pending } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [{ id: 21, phase: 'RUNNING', lastActivityAt: sqlTime(10 * 60_000) }],
    });

    await runner.sweepOrphans();
    await Promise.all(pending);

    expect(sessionMapper.selectById).toHaveBeenCalledWith(21);
  });

  it('skipsLocallyActiveSessions', async () => {
    const dir = useTmpDir('mao-sweep-local-');
    writeActivePort(dir, 9081);
    const { runner, sessionMapper, pending } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [{ id: 8, phase: 'RUNNING', lastActivityAt: sqlTime(10 * 60_000) }],
      locallyActiveIds: [8],
    });

    await runner.sweepOrphans();
    await Promise.all(pending);

    expect(sessionMapper.selectById).not.toHaveBeenCalled();
  });

  it('skipsSessionsBlockedByInflightSubagentExecutions', async () => {
    const dir = useTmpDir('mao-sweep-subagent-');
    writeActivePort(dir, 9081);
    // 父会话在等后台子代理，自身长时间无活动，但仍在正常运行——不能当孤儿重跑。
    const { runner, sessionMapper, pending, coordinator } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [{ id: 9, phase: 'RUNNING', lastActivityAt: sqlTime(10 * 60_000) }],
      blockedIds: [9],
    });

    await runner.sweepOrphans();
    await Promise.all(pending);

    expect(coordinator.listBlockedSessionIds).toHaveBeenCalled();
    expect(sessionMapper.selectById).not.toHaveBeenCalled();
  });

  it('sweepsAsSingleInstanceWhenActivePortFileIsMissing', async () => {
    const dir = useTmpDir('mao-sweep-noport-');
    // 单实例/非蓝绿安装不写 active-backend-port：没有第二个实例可抢，巡检必须照常生效，
    // 否则"覆盖非部署原因的执行中断"在单实例环境静默失效。
    const { runner, sessionMapper, pending } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9080,
      sessions: [{ id: 12, phase: 'RESUMING' }],
    });

    await runner.sweepOrphans();
    await Promise.all(pending);

    expect(sessionMapper.selectById).toHaveBeenCalledWith(12);
  });

  it('doesNotDegradeWhenDeployLockExistsWithoutActivePortFile', async () => {
    const dir = useTmpDir('mao-sweep-noport-lock-');
    writeLock(dir, 'starting');
    const { runner, sessionMapper } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9080,
      sessions: [{ id: 13, phase: 'RESUMING' }],
    });

    await runner.sweepOrphans();

    expect(sessionMapper.selectById).not.toHaveBeenCalled();
  });

  it('sweepsAfterDrainWindowEvenIfStatusStuckAtSwitched', async () => {
    const dir = useTmpDir('mao-sweep-stuck-lock-');
    writeActivePort(dir, 9081);
    // drain 脚本异常没写 drained：状态停在 switched。不能因此让巡检停摆 15 分钟，
    // 超过"排空窗口 + 余量"即视为部署已结束。
    writeLock(dir, 'switched', 60 + 60 + 10);
    const { runner, sessionMapper, pending } = makeSweepRunner({
      runtimeDir: dir,
      selfPort: 9081,
      sessions: [{ id: 14, phase: 'RESUMING' }],
    });

    await runner.sweepOrphans();
    await Promise.all(pending);

    expect(sessionMapper.selectById).toHaveBeenCalledWith(14);
  });

  it('recoversOrphanOnIntervalAndStopsAfterStopPeriodicSweep', async () => {    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-sweep-periodic-');
      writeActivePort(dir, 9081);
      const { runner, sessionMapper, pending } = makeSweepRunner({
        runtimeDir: dir,
        selfPort: 9081,
        sessions: [{ id: 11, phase: 'RESUMING' }],
      });

      runner.startPeriodicSweep();
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all(pending);
      expect(sessionMapper.selectById).toHaveBeenCalledWith(11);

      runner.stopPeriodicSweep();
      sessionMapper.selectById.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessionMapper.selectById).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
