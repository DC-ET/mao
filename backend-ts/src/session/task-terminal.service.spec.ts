import { describe, expect, it, vi } from 'vitest';
import { TaskTerminalService } from './task-terminal.service.js';
import type { SessionService } from './session.service.js';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    userId: 7,
    agentId: 2,
    title: '任务',
    status: 'ACTIVE',
    phase: 'RUNNING',
    sessionType: 'NORMAL',
    projectKey: 'mao',
    workspace: '/ws/mao',
    unread: 0,
    ...overrides,
  };
}

interface Harness {
  terminal: TaskTerminalService;
  extraction: { extractForSession: ReturnType<typeof vi.fn> };
  memoryJobs: Array<() => void | Promise<void>>;
  notificationJobs: Array<() => void | Promise<void>>;
}

function build(sessionOverrides: Record<string, unknown> = {}): Harness {
  const sessionService = {
    getSession: vi.fn(async () => session(sessionOverrides)),
    updateRuntimeStatus: vi.fn(async () => undefined),
    updatePhase: vi.fn(async () => undefined),
    markLastMessageFinished: vi.fn(async () => undefined),
  } as never as SessionService;
  const registry = {
    send: vi.fn(() => undefined),
    sendWithResult: vi.fn(async () => ({} as never)),
  } as never;
  const deliveryService = { prepare: vi.fn(async () => null) } as never;
  const treeSignalPublisher = { publish: vi.fn() } as never;
  const extraction = { extractForSession: vi.fn(async () => undefined) };
  const notificationJobs: Array<() => void | Promise<void>> = [];
  const memoryJobs: Array<() => void | Promise<void>> = [];
  const terminal = new TaskTerminalService(
    sessionService,
    registry,
    deliveryService,
    treeSignalPublisher,
    (fn) => { notificationJobs.push(fn); },
    extraction,
    (fn) => { memoryJobs.push(fn); },
  );
  return { terminal, extraction, memoryJobs, notificationJobs };
}

describe('TaskTerminalService memory extraction dispatch', () => {
  it('dispatchesOnceForCompletedMainSessionWithSessionContext', async () => {
    const h = build();
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    expect(h.memoryJobs).toHaveLength(1);
    h.memoryJobs.forEach((job) => { void job(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.extraction.extractForSession).toHaveBeenCalledTimes(1);
    expect(h.extraction.extractForSession).toHaveBeenCalledWith({
      sessionId: 11,
      userId: 7,
      projectKey: 'mao',
      workspace: '/ws/mao',
      agentId: 2,
    });
  });

  it('doesNotDispatchForFailedOrCancelled', async () => {
    const h = build();
    await h.terminal.finishExecution(11, 7, 'FAILED', 'exec-1', 'boom');
    await h.terminal.finishExecution(11, 7, 'CANCELLED', 'exec-1');
    expect(h.memoryJobs).toHaveLength(0);
    expect(h.extraction.extractForSession).not.toHaveBeenCalled();
  });

  it('doesNotDispatchForSubagentOrSideTask', async () => {
    const h = build({ sessionType: 'SUBAGENT', projectKey: null, workspace: null });
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    expect(h.memoryJobs).toHaveLength(0);

    const h2 = build({ sessionType: 'SIDE_TASK', parentSessionId: 3 });
    await h2.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    expect(h2.memoryJobs).toHaveLength(0);
  });

  it('skipsDispatchWhenNoExtractionWired', async () => {
    const sessionService = {
      getSession: vi.fn(async () => session()),
      updateRuntimeStatus: vi.fn(async () => undefined),
      updatePhase: vi.fn(async () => undefined),
      markLastMessageFinished: vi.fn(async () => undefined),
    } as never as SessionService;
    const terminal = new TaskTerminalService(
      sessionService,
      { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
      { prepare: vi.fn(async () => null) } as never,
      { publish: vi.fn() } as never,
    );
    await expect(terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1')).resolves.toBeUndefined();
  });

  it('extractionFailureDoesNotBreakFinishExecutionEventChain', async () => {
    // 注入同步 executor：抽取调用在 finishExecution 返回前同步执行，模拟抽取全程抛错
    const sessionService = {
      getSession: vi.fn(async () => session()),
      updateRuntimeStatus: vi.fn(async () => undefined),
      updatePhase: vi.fn(async () => undefined),
      markLastMessageFinished: vi.fn(async () => undefined),
    } as never as SessionService;
    const treeSignalPublisher = { publish: vi.fn() } as never;
    const extraction = { extractForSession: vi.fn(async () => { throw new Error('extraction exploded'); }) };
    const terminal = new TaskTerminalService(
      sessionService,
      { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
      { prepare: vi.fn(async () => null) } as never,
      treeSignalPublisher,
      (fn) => { void Promise.resolve().then(fn); },
      extraction,
      (fn) => { void Promise.resolve().then(fn); },
    );
    await expect(terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1')).resolves.toBeUndefined();
    // 既有事件链完整发生
    expect(sessionService.updatePhase).toHaveBeenCalledWith(11, 'COMPLETED');
    expect(sessionService.markLastMessageFinished).toHaveBeenCalledWith(11);
    expect(treeSignalPublisher.publish).toHaveBeenCalledWith(11);
    expect(extraction.extractForSession).toHaveBeenCalledTimes(1);
  });

  it('doesNotDispatchOnAlreadyTerminalSession', async () => {
    const h = build({ phase: 'COMPLETED' });
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    expect(h.memoryJobs).toHaveLength(0);
  });
});
