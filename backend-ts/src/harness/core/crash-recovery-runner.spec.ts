import { describe, expect, it, vi } from 'vitest';

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
    '/tmp/mao-crash-recovery-spec-runtime-missing',
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
