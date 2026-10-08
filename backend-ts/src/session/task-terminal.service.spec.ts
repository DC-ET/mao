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

describe('TaskTerminalService 预算 WARN 结算（§5.8）', () => {
  function buildWithWarner(sessionOverrides: Record<string, unknown> = {}, warner: { settleWarn: ReturnType<typeof vi.fn> } | null = { settleWarn: vi.fn(async () => undefined) }) {
    const sessionService = {
      getSession: vi.fn(async () => session(sessionOverrides)),
      updateRuntimeStatus: vi.fn(async () => undefined),
      updatePhase: vi.fn(async () => undefined),
      markLastMessageFinished: vi.fn(async () => undefined),
    };
    const notificationJobs: Array<() => void | Promise<void>> = [];
    const terminal = new TaskTerminalService(
      sessionService as never as SessionService,
      { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
      { prepare: vi.fn(async () => null) } as never,
      { publish: vi.fn(), publishAtRoot: vi.fn() } as never,
      (fn) => { notificationJobs.push(fn); },
      { extractForSession: vi.fn(async () => undefined) },
      (fn) => { void Promise.resolve().then(fn); },
      { recordTaskTerminal: vi.fn(async () => undefined) },
      'MANUAL',
      null,
      warner as never,
    );
    return { terminal, warner, notificationJobs };
  }

  async function flush(h: { notificationJobs: Array<() => void | Promise<void>> }): Promise<void> {
    h.notificationJobs.forEach((job) => { void job(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('COMPLETED / FAILED 终态按会话归属结算一次', async () => {
    const h = buildWithWarner();
    await h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
    await flush(h);
    expect(h.warner!.settleWarn).toHaveBeenCalledTimes(1);
    expect(h.warner!.settleWarn).toHaveBeenCalledWith({ userId: 7, agentId: 2 }, 7);

    const failed = buildWithWarner();
    await failed.terminal.finishExecution(11, 7, 'FAILED', 'exec-2', 'boom');
    await flush(failed);
    expect(failed.warner!.settleWarn).toHaveBeenCalledWith({ userId: 7, agentId: 2 }, 7);
  });

  it('CANCELLED 不结算；SUBAGENT / SIDE_TASK 不结算（跟随父会话）', async () => {
    const cancelled = buildWithWarner();
    await cancelled.terminal.finishExecution(11, 7, 'CANCELLED', 'exec-1');
    await flush(cancelled);
    expect(cancelled.warner!.settleWarn).not.toHaveBeenCalled();

    for (const sessionType of ['SUBAGENT', 'SIDE_TASK']) {
      const child = buildWithWarner({ sessionType, parentSessionId: 3 });
      await child.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1');
      await flush(child);
      expect(child.warner!.settleWarn, sessionType).not.toHaveBeenCalled();
    }
  });

  it('未知用户（ownerId 为空）不结算', async () => {
    const h = buildWithWarner({ userId: null });
    await h.terminal.finishExecution(11, null, 'COMPLETED', 'exec-1');
    await flush(h);
    expect(h.warner!.settleWarn).not.toHaveBeenCalled();
  });

  it('settleWarn 抛错被吞：不影响任务终态事件链', async () => {
    const warner = { settleWarn: vi.fn(async () => { throw new Error('budget down'); }) };
    const h = buildWithWarner({}, warner);
    await expect(h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1')).resolves.toBeUndefined();
    await flush(h);
    expect(warner.settleWarn).toHaveBeenCalledTimes(1);
    expect(h.terminal).toBeTruthy();
  });

  it('未注入 budgetWarner（budget 域未装配）时零影响', async () => {
    const h = buildWithWarner({}, null);
    await expect(h.terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1')).resolves.toBeUndefined();
    await flush(h);
  });

  // 两条提交点共用同一个 notificationExecutor，队列饱和时同步抛错都会砸穿 finishExecution
  // （终态相位已落库，上层把已完成任务改判 FAILED、连败计数与队列回写被污染）。
  // recordInbox 是存量洞，本特性给同一有界队列追加了第二个提交者后饱和概率实质上更贴近。
  it.each([
    ['recordInbox', true],
    ['settleBudgetWarn', false],
  ])('%s 的 executor 同步抛错（队列饱和）不得影响 finishExecution 返回', async (_label, withInbox) => {
    const sessionService = {
      getSession: vi.fn(async () => session()),
      updateRuntimeStatus: vi.fn(async () => undefined),
      updatePhase: vi.fn(async () => undefined),
      markLastMessageFinished: vi.fn(async () => undefined),
    };
    const warner = { settleWarn: vi.fn(async () => undefined) };
    const inbox = { recordTaskTerminal: vi.fn(async () => undefined) };
    let submitCalls = 0;
    const terminal = new TaskTerminalService(
      sessionService as never as SessionService,
      { send: vi.fn(), sendWithResult: vi.fn(async () => ({} as never)) } as never,
      { prepare: vi.fn(async () => null) } as never,
      { publish: vi.fn(), publishAtRoot: vi.fn() } as never,
      () => { submitCalls++; throw new Error('pool exhausted'); },
      { extractForSession: vi.fn(async () => undefined) },
      (fn) => { void Promise.resolve().then(fn); },
      withInbox ? (inbox as never) : null,
      'MANUAL',
      null,
      warner as never,
    );
    await expect(terminal.finishExecution(11, 7, 'COMPLETED', 'exec-1')).resolves.toBeUndefined();
    // 走到 submit 说明前置过滤都通过，抛错被 try/catch 吞掉（注入 inbox 时 recordInbox 先提交 1 次）
    expect(submitCalls).toBe(withInbox ? 2 : 1);
    expect(inbox.recordTaskTerminal).not.toHaveBeenCalled();
    expect(warner.settleWarn).not.toHaveBeenCalled();
  });
});
