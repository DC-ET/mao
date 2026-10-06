import { describe, expect, it, vi } from 'vitest';
import { TaskTerminalService, type TaskTerminalInboxRecorder } from './task-terminal.service.js';
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
  sessionService: Record<string, ReturnType<typeof vi.fn>>;
  treeSignalPublisher: { publish: ReturnType<typeof vi.fn>; publishAtRoot: ReturnType<typeof vi.fn> };
  extraction: { extractForSession: ReturnType<typeof vi.fn> };
  inbox: TaskTerminalInboxRecorder & { recordTaskTerminal: ReturnType<typeof vi.fn> };
  notificationJobs: Array<() => void | Promise<void>>;
  memoryJobs: Array<() => void | Promise<void>>;
}

function build(sessionOverrides: Record<string, unknown> = {}): Harness {
  const sessionService = {
    getSession: vi.fn(async () => session(sessionOverrides)),
    updateRuntimeStatus: vi.fn(async () => undefined),
    updatePhase: vi.fn(async () => undefined),
    markLastMessageFinished: vi.fn(async () => undefined),
  };
  const treeSignalPublisher = { publish: vi.fn(), publishAtRoot: vi.fn() };
  const extraction = { extractForSession: vi.fn(async () => undefined) };
  const inbox = { recordTaskTerminal: vi.fn(async () => undefined) };
  const notificationJobs: Array<() => void | Promise<void>> = [];
  const memoryJobs: Array<() => void | Promise<void>> = [];
  const terminal = new TaskTerminalService(
    sessionService as never as SessionService,
    { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
    { prepare: vi.fn(async () => null) } as never,
    treeSignalPublisher as never,
    (fn) => { notificationJobs.push(fn); },
    extraction,
    (fn) => { memoryJobs.push(fn); },
    inbox,
    'MANUAL',
  );
  return { terminal, sessionService, treeSignalPublisher, extraction, inbox, notificationJobs, memoryJobs };
}

/** 收件箱副作用是 fire-and-forget：把排队的 job 跑完并让微任务队列排空。 */
async function flush(h: Harness): Promise<void> {
  h.notificationJobs.forEach((job) => { void job(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('extractionFailureDoesNotBreakFinishExecutionEventChain', async () => {
    // 注入同步 executor：抽取调用在 finishExecution 返回前同步执行，模拟抽取全程抛错
    const sessionService = {
      getSession: vi.fn(async () => session()),
      updateRuntimeStatus: vi.fn(async () => undefined),
      updatePhase: vi.fn(async () => undefined),
      markLastMessageFinished: vi.fn(async () => undefined),
    };
    const treeSignalPublisher = { publish: vi.fn(), publishAtRoot: vi.fn() };
    const extraction = { extractForSession: vi.fn(async () => { throw new Error('extraction exploded'); }) };
    const terminal = new TaskTerminalService(
      sessionService as never as SessionService,
      { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
      { prepare: vi.fn(async () => null) } as never,
      treeSignalPublisher as never,
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

describe('TaskTerminalService 收件箱写入', () => {
  it('COMPLETED / FAILED 各记一次，并带上正确 notifySource', async () => {
    const h = build();
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1', undefined, 'SCHEDULED');
    await flush(h);
    expect(h.inbox.recordTaskTerminal).toHaveBeenCalledTimes(1);
    expect(h.inbox.recordTaskTerminal).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, sessionId: 11, title: '任务', phase: 'COMPLETED',
      executionId: 'exec-1', source: 'SCHEDULED',
    }));

    const h2 = build();
    await h2.terminal.finishExecution(11, 7, 'FAILED', 'exec-2', 'boom', 'MANUAL');
    await flush(h2);
    expect(h2.inbox.recordTaskTerminal).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'FAILED', failureReason: 'boom', source: 'MANUAL',
    }));
  });

  it('默认 notifySource 为 MANUAL（第 6 参缺省时）', async () => {
    const h = build();
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(h);
    expect(h.inbox.recordTaskTerminal).toHaveBeenCalledWith(expect.objectContaining({ source: 'MANUAL' }));
  });

  it('CANCELLED 不写收件箱', async () => {
    const h = build();
    await h.terminal.finishExecution(11, 7, 'CANCELLED', 'exec-1');
    await flush(h);
    expect(h.inbox.recordTaskTerminal).not.toHaveBeenCalled();
  });

  it('SUBAGENT / SIDE_TASK 会话不写（含 SIDE_TASK + parentSessionId=null 的提升边界）', async () => {
    const subagent = build({ sessionType: 'SUBAGENT', parentSessionId: 11 });
    await subagent.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(subagent);
    expect(subagent.inbox.recordTaskTerminal).not.toHaveBeenCalled();

    const promoted = build({ sessionType: 'SIDE_TASK', parentSessionId: null });
    await promoted.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(promoted);
    expect(promoted.inbox.recordTaskTerminal).not.toHaveBeenCalled();

    const sideTask = build({ sessionType: 'SIDE_TASK', parentSessionId: 3 });
    await sideTask.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(sideTask);
    expect(sideTask.inbox.recordTaskTerminal).not.toHaveBeenCalled();
  });

  it('NORMAL + parentSessionId=3（被提升过的边路任务）记 1 条收件箱', async () => {
    const h = build({ sessionType: 'NORMAL', parentSessionId: 3 });
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(h);
    expect(h.inbox.recordTaskTerminal).toHaveBeenCalledTimes(1);
  });

  it('微信 / 飞书通道会话不写', async () => {
    const weixin = build({ projectKey: 'weixin-bot' });
    await weixin.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(weixin);
    expect(weixin.inbox.recordTaskTerminal).not.toHaveBeenCalled();

    // 飞书会话：projectKey 以 feishu- 开头即飞书通道
    const feishu = build({ projectKey: 'feishu-1-private-7' });
    await feishu.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(feishu);
    expect(feishu.inbox.recordTaskTerminal).not.toHaveBeenCalled();
  });

  it('未知用户（session.userId 为空且调用方未传）不写', async () => {
    const h = build({ userId: null });
    await h.terminal.finishExecution(11, null, 'COMPLETED', 'exec-1');
    await flush(h);
    expect(h.inbox.recordTaskTerminal).not.toHaveBeenCalled();
  });

  it('已终态会话早退，不重复写', async () => {
    const h = build({ phase: 'COMPLETED' });
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(h);
    expect(h.inbox.recordTaskTerminal).not.toHaveBeenCalled();
  });

  it('未注入 inboxRecorder 时行为与改造前一致（零影响）', async () => {
    const sessionService = {
      getSession: vi.fn(async () => session()),
      updateRuntimeStatus: vi.fn(async () => undefined),
      updatePhase: vi.fn(async () => undefined),
      markLastMessageFinished: vi.fn(async () => undefined),
    };
    const treeSignalPublisher = { publish: vi.fn(), publishAtRoot: vi.fn() };
    const terminal = new TaskTerminalService(
      sessionService as never as SessionService,
      { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
      { prepare: vi.fn(async () => null) } as never,
      treeSignalPublisher as never,
      (fn) => { void Promise.resolve().then(fn); },
    );
    await expect(terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1')).resolves.toBeUndefined();
    expect(sessionService.updatePhase).toHaveBeenCalledWith(11, 'COMPLETED');
    expect(treeSignalPublisher.publish).toHaveBeenCalledWith(11);
  });
});
