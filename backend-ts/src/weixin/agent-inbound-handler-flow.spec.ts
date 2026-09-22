import { describe, expect, it, vi, afterEach } from 'vitest';
import { AgentWeixinInboundHandler, type AgentWeixinInboundHandlerDeps } from './agent-inbound-handler.js';
import type { WeixinInboundMessageContext } from './types.js';
import { AtomicBoolean } from '../harness/atomic-boolean.js';

describe('AgentWeixinInboundHandler cancel replace', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('newerMessageCancelsPreviousAndOnlyLatestReplies', async () => {
    const firstFlag = new AtomicBoolean(false);
    const secondFlag = new AtomicBoolean(false);
    const flags = [firstFlag, secondFlag];
    let flagIdx = 0;
    let firstStarted!: () => void;
    const firstStartedP = new Promise<void>((r) => { firstStarted = r; });
    let allowFirst!: () => void;
    const allowFirstP = new Promise<void>((r) => { allowFirst = r; });

    const harnessService = {
      prepareMessage: vi.fn(async () => 'exec-1'),
      execute: vi.fn(async (_sid: number, _eid: string | null, _l: unknown, flag: AtomicBoolean) => {
        if (flag === firstFlag) {
          firstStarted();
          await allowFirstP;
          return;
        }
      }),
    };
    const sessionService = {
      saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'latest-reply' }]),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
    };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService,
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: { registerCancelFlag: vi.fn(() => flags[Math.min(flagIdx++, flags.length - 1)]) },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const first = handler.onMessage({ accountId: 'acc-1', body: 'msg-1' } as WeixinInboundMessageContext);
    await firstStartedP;
    const second = handler.onMessage({ accountId: 'acc-1', body: 'msg-2' } as WeixinInboundMessageContext);
    await vi.waitFor(() => {
      expect(firstFlag.get()).toBe(true);
    });
    allowFirst();
    const firstReply = await first;
    const secondReply = await second;
    expect(firstReply).toBeNull();
    expect(secondReply?.text).toBe('latest-reply');
    handler.shutdown();
  });

  it('shutdownSkipsPendingMessageAndRollbacksOrphanUserMessage', async () => {
    const sessionService = {
      saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => []),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
      deleteMessageById: vi.fn(async () => {}),
    };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute: vi.fn(async () => {}) },
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: { registerCancelFlag: vi.fn(() => new AtomicBoolean(false)) },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);
    // 停机后到达的消息不会被执行：走跳过分支，需回滚本轮孤立 USER 消息并 resolve null。
    handler.shutdown();
    const reply = await handler.onMessage({ accountId: 'acc-1', body: 'msg-1' } as WeixinInboundMessageContext);
    expect(reply).toBeNull();
    expect(sessionService.deleteMessageById).toHaveBeenCalledWith(100, 10);
    expect(sessionService.updatePhase).not.toHaveBeenCalled();
    handler.shutdown();
  });

  it('waits for a desktop loop to release before starting', async () => {
    const desktopFlag = new AtomicBoolean(false);
    let current: AtomicBoolean | undefined = desktopFlag;
    const weixinFlag = new AtomicBoolean(false);
    let phase = 'RUNNING';
    const execute = vi.fn(async () => undefined);
    const deleteMessageById = vi.fn(async () => undefined);
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute },
      sessionService: {
        saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
        updatePhase: vi.fn(),
        getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'wx-reply' }]),
        cleanupIncompleteTail: vi.fn(async () => 0),
        updateContextTokens: vi.fn(),
        deleteMessageById,
        getSession: vi.fn(async () => ({ phase })),
      },
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: {
        getCancelFlag: () => current,
        requestCancel: () => { current?.set(true); },
        registerCancelFlag: () => { current = weixinFlag; return weixinFlag; },
      },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const pending = handler.onMessage({ accountId: 'acc-1', body: 'from-weixin' } as WeixinInboundMessageContext);
    await vi.waitFor(() => expect(desktopFlag.get()).toBe(true));
    expect(execute).not.toHaveBeenCalled();
    current = undefined;
    phase = 'CANCELLED';
    await expect(pending).resolves.toEqual({ text: 'wx-reply' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deleteMessageById).not.toHaveBeenCalled();
    handler.shutdown();
  });

  it('does not start while the desktop flag is still held after the phase leaves running', async () => {
    const desktopFlag = new AtomicBoolean(false);
    let current: AtomicBoolean | undefined = desktopFlag;
    let phase = 'RUNNING';
    const execute = vi.fn(async () => undefined);
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute },
      sessionService: {
        saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
        updatePhase: vi.fn(),
        getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'wx-reply' }]),
        cleanupIncompleteTail: vi.fn(async () => 0),
        updateContextTokens: vi.fn(),
        deleteMessageById: vi.fn(),
        getSession: vi.fn(async () => ({ phase })),
      },
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: {
        getCancelFlag: () => current,
        requestCancel: () => { desktopFlag.set(true); },
        registerCancelFlag: () => new AtomicBoolean(false),
      },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const pending = handler.onMessage({ accountId: 'acc-1', body: 'from-weixin' } as WeixinInboundMessageContext);
    await vi.waitFor(() => expect(desktopFlag.get()).toBe(true));
    phase = 'CANCELLED';
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(execute).not.toHaveBeenCalled();
    current = undefined;
    await expect(pending).resolves.toEqual({ text: 'wx-reply' });
    handler.shutdown();
  });

  it('does not start when the desktop flag is already gone but the phase is still running', async () => {
    let phase = 'RUNNING';
    let current: AtomicBoolean | undefined;
    const queued = new AtomicBoolean(false);
    const execute = vi.fn(async () => undefined);
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute },
      sessionService: {
        saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
        updatePhase: vi.fn(),
        getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'wx-reply' }]),
        cleanupIncompleteTail: vi.fn(async () => 0),
        updateContextTokens: vi.fn(),
        deleteMessageById: vi.fn(),
        getSession: vi.fn(async () => ({ phase })),
      },
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: {
        getCancelFlag: () => current,
        requestCancel: () => undefined,
        registerCancelFlag: () => new AtomicBoolean(false),
      },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const pending = handler.onMessage({ accountId: 'acc-1', body: 'from-weixin' } as WeixinInboundMessageContext);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(execute).not.toHaveBeenCalled();
    phase = 'CANCELLED';
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(execute).not.toHaveBeenCalled();
    current = queued;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(execute).not.toHaveBeenCalled();
    current = undefined;
    await expect(pending).resolves.toEqual({ text: 'wx-reply' });
    expect(execute).toHaveBeenCalledTimes(1);
    handler.shutdown();
  });

  it('drops the cancel flag when execution fails before the agent loop', async () => {
    const flags = new Map<number, AtomicBoolean>();
    const removeCancelFlag = vi.fn((sessionId: number) => { flags.delete(sessionId); });
    let executeCalls = 0;
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: {
        prepareMessage: vi.fn(async () => 'exec-1'),
        execute: vi.fn(async () => {
          executeCalls += 1;
          if (executeCalls === 1) throw new Error('模型不存在');
        }),
      },
      sessionService: {
        saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
        updatePhase: vi.fn(),
        getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'wx-reply' }]),
        cleanupIncompleteTail: vi.fn(async () => 0),
        updateContextTokens: vi.fn(),
        deleteMessageById: vi.fn(),
        getSession: vi.fn(async () => ({ phase: 'FAILED' })),
      },
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: {
        registerCancelFlag: (sessionId: number) => {
          const flag = new AtomicBoolean(false);
          flags.set(sessionId, flag);
          return flag;
        },
        getCancelFlag: (sessionId: number) => flags.get(sessionId),
        requestCancel: (sessionId: number) => flags.get(sessionId)?.set(true),
        removeCancelFlag,
      },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const first = await handler.onMessage({ accountId: 'acc-1', body: 'first' } as WeixinInboundMessageContext);
    expect(first?.text).toContain('请稍后再试');
    expect(removeCancelFlag).toHaveBeenCalledWith(100);
    expect(flags.has(100)).toBe(false);

    const second = await handler.onMessage({ accountId: 'acc-1', body: 'second' } as WeixinInboundMessageContext);
    expect(second?.text).toBe('wx-reply');
    expect(executeCalls).toBe(2);
    handler.shutdown();
  });

  it('does not treat an idle phase with a live desktop flag as a stale loop', async () => {
    const desktopFlag = new AtomicBoolean(true);
    const execute = vi.fn(async () => undefined);
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute },
      sessionService: {
        saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
        updatePhase: vi.fn(),
        getMessages: vi.fn(async () => []),
        cleanupIncompleteTail: vi.fn(async () => 0),
        updateContextTokens: vi.fn(),
        deleteMessageById: vi.fn(),
        getSession: vi.fn(async () => ({ phase: 'IDLE' })),
      },
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: {
        getCancelFlag: () => desktopFlag,
        requestCancel: () => undefined,
        registerCancelFlag: () => new AtomicBoolean(false),
      },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const pending = handler.onMessage({ accountId: 'acc-1', body: 'from-weixin' } as WeixinInboundMessageContext);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(execute).not.toHaveBeenCalled();
    handler.shutdown();
    await expect(pending).resolves.toBeNull();
  });
});

describe('AgentWeixinInboundHandler file error', () => {
  function prepare(extra: Partial<AgentWeixinInboundHandlerDeps> = {}) {
    const sessionService = {
      saveMessage: vi.fn(async () => ({ id: 1 })),
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => []),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
    };
    const harnessService = {
      prepareMessage: vi.fn(async () => 'exec-1'),
      execute: vi.fn(async () => {}),
    };
    const shellSessionManager = { closeByConversation: vi.fn() };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1, workspace: '/ws' })) },
      harnessService,
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: { registerCancelFlag: vi.fn(() => new AtomicBoolean(false)) },
      shellSessionManager,
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
      ...extra,
    } as unknown as AgentWeixinInboundHandlerDeps);
    return { handler, harnessService, shellSessionManager };
  }

  it('allFilesDownloadFailed_withoutOtherContent_repliesErrorWithoutTriggeringAgent', async () => {
    const { handler, harnessService } = prepare();
    const reply = await handler.onMessage({
      accountId: 'acc-1', fromUserId: 'wx-1', body: '', fileDownloadErrors: ['broken.pdf'],
    });
    expect(reply?.text).toContain('文件接收失败');
    expect(reply?.text).toContain('broken.pdf');
    expect(harnessService.prepareMessage).not.toHaveBeenCalled();
    handler.shutdown();
  });

  it('fileFailure_cancelsInFlightExecution', async () => {
    const { handler, shellSessionManager } = prepare();
    await handler.onMessage({
      accountId: 'acc-1', fromUserId: 'wx-1', body: '', fileDownloadErrors: ['broken.pdf'],
    });
    expect(shellSessionManager.closeByConversation).toHaveBeenCalledWith(100);
    handler.shutdown();
  });

  it('allFilesDownloadFailed_withText_continuesProcessingText', async () => {
    const { handler, harnessService } = prepare();
    const reply = await handler.onMessage({
      accountId: 'acc-1', fromUserId: 'wx-1', body: '帮我分析这个', fileDownloadErrors: ['broken.pdf'],
    });
    expect(harnessService.prepareMessage).toHaveBeenCalled();
    expect(reply).not.toBeNull();
    expect(reply?.text ?? '').not.toContain('文件接收失败');
    handler.shutdown();
  });
});
