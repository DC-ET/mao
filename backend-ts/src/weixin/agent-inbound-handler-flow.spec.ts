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

describe('AgentWeixinInboundHandler 平台队列接力（0.0.434）', () => {
  function makeHandler(extra: Partial<AgentWeixinInboundHandlerDeps> = {}) {
    return new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute: vi.fn(async () => undefined) },
      sessionService: {
        saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
        updatePhase: vi.fn(),
        getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'wx-reply' }]),
        cleanupIncompleteTail: vi.fn(async () => 0),
        updateContextTokens: vi.fn(),
        deleteMessageById: vi.fn(async () => undefined),
        getSession: vi.fn(async () => ({ phase: 'COMPLETED' })),
      },
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
      ...extra,
    } as unknown as AgentWeixinInboundHandlerDeps);
  }

  it('执行成功后接力消费平台排队消息', async () => {
    const onQueuesDrained = vi.fn();
    const handler = makeHandler({ onQueuesDrained });
    const reply = await handler.onMessage({ accountId: 'acc-1', fromUserId: 'wx-1', body: 'msg-1' });
    expect(reply?.text).toBe('wx-reply');
    // 接力在 runAgent 返回（执行旗标释放）后异步触发
    await vi.waitFor(() => expect(onQueuesDrained).toHaveBeenCalledWith(100));
    handler.shutdown();
  });

  it('setter 注入生效；执行失败时不接力', async () => {
    const onQueuesDrained = vi.fn();
    const handler = makeHandler({
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute: vi.fn(async () => { throw new Error('boom'); }) },
    });
    handler.setOnQueuesDrained(onQueuesDrained);
    const reply = await handler.onMessage({ accountId: 'acc-1', fromUserId: 'wx-1', body: 'msg-1' });
    expect(String(reply?.text ?? '')).toContain('抱歉');
    expect(onQueuesDrained).not.toHaveBeenCalled();
    handler.shutdown();
  });

  it('接力发生在执行旗标释放之后（WS 跨通道忙检查不会挡住自己）', async () => {
    let handlerRef!: AgentWeixinInboundHandler;
    let runningAtRelay: boolean | null = null;
    const onQueuesDrained = vi.fn(() => {
      runningAtRelay = handlerRef.hasRunningSession(100);
    });
    handlerRef = makeHandler({ onQueuesDrained });
    await handlerRef.onMessage({ accountId: 'acc-1', fromUserId: 'wx-1', body: 'msg-1' });
    await vi.waitFor(() => expect(onQueuesDrained).toHaveBeenCalled());
    expect(runningAtRelay).toBe(false);
    handlerRef.shutdown();
  });

  it('WS 侧执行占位时放弃执行并提示稍后再发', async () => {
    const handler = makeHandler({ isSessionExecuting: () => true });
    const reply = await handler.onMessage({ accountId: 'acc-1', fromUserId: 'wx-1', body: 'msg-1' });
    expect(reply?.text).toBe('当前会话仍在执行，请稍后再发。');
    handler.shutdown();
  });
});

describe('AgentWeixinInboundHandler 渠道控制命令（2026-11-22 技术方案）', () => {
  interface DepsOverrides {
    createNewSession?: ReturnType<typeof vi.fn>;
    listRecentSessions?: ReturnType<typeof vi.fn>;
    switchSession?: ReturnType<typeof vi.fn>;
    cancelFlag?: { get(): boolean; set(v: boolean): void } | null;
  }

  function makeCommandHandler(overrides: DepsOverrides = {}) {
    const flag = overrides.cancelFlag ?? null;
    const createNewSession = overrides.createNewSession ?? vi.fn(async () => ({ id: 101, userId: 1 }));
    const listRecentSessions = overrides.listRecentSessions ?? vi.fn(async () => []);
    const switchSession = overrides.switchSession ?? vi.fn(async () => ({ outcome: 'REJECTED' }) as never);
    const saveMessage = vi.fn(async () => ({ id: 10, content: 'msg' }));
    const prepareMessage = vi.fn(async () => 'exec-1');
    const execute = vi.fn(async () => undefined);
    const closeByConversation = vi.fn();
    const registry = { send: vi.fn() };
    const sessionService = {
      saveMessage,
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'latest-reply' }]),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
    };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: {
        getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })),
        createNewSession,
        listRecentSessions,
        switchSession,
      },
      harnessService: { prepareMessage, execute },
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: {
        registerCancelFlag: vi.fn(() => ({ get: () => false, set: () => undefined })),
        // 仅在需要忙判定的用例提供 getCancelFlag；缺省不提供（waitForForeignLoop 直接放行，
        // 非命令文本的原链路不被 800ms 安静窗拖慢）。
        ...(flag != null ? { getCancelFlag: vi.fn(() => flag) } : {}),
        requestCancel: vi.fn(),
      },
      shellSessionManager: { closeByConversation },
      registry,
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);
    return { handler, createNewSession, listRecentSessions, switchSession, saveMessage, prepareMessage, execute, closeByConversation, registry };
  }

  it('/stop 忙（loop 有取消旗标）：置旗 + 关 shell，回复已停止；不落库不开新执行', async () => {
    const flag = { value: false, get: () => flag.value, set: (v: boolean) => { flag.value = v; } };
    const { handler, saveMessage, prepareMessage } = makeCommandHandler({ cancelFlag: flag });
    const reply = await handler.onMessage({ accountId: 'acc-1', body: '/stop' } as WeixinInboundMessageContext);
    expect(flag.value).toBe(true);
    expect(reply?.text).toBe('已停止当前任务。');
    expect(saveMessage).not.toHaveBeenCalled();
    expect(prepareMessage).not.toHaveBeenCalled();
  });

  it('/stop 空闲：仅提示，无任何副作用', async () => {
    const { handler, saveMessage, prepareMessage, closeByConversation } = makeCommandHandler({ cancelFlag: null });
    const reply = await handler.onMessage({ accountId: 'acc-1', body: '/stop' } as WeixinInboundMessageContext);
    expect(reply?.text).toBe('当前没有进行中的任务。');
    expect(saveMessage).not.toHaveBeenCalled();
    expect(prepareMessage).not.toHaveBeenCalled();
    expect(closeByConversation).not.toHaveBeenCalled();
  });

  it('/new：建新会话并回复确认；不打断旧执行（不关 shell）', async () => {
    const { handler, createNewSession, closeByConversation, saveMessage, prepareMessage } = makeCommandHandler({});
    const reply = await handler.onMessage({ accountId: 'acc-1', body: '/new' } as WeixinInboundMessageContext);
    expect(createNewSession).toHaveBeenCalledWith(1);
    expect(reply?.text).toBe('已开启新会话，后续消息将在新的上下文中处理。');
    expect(closeByConversation).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
    expect(prepareMessage).not.toHaveBeenCalled();
  });

  it('/tasks：查本人简报并回复列表', async () => {
    const listRecentSessions = vi.fn(async () => [
      { id: 100, title: '查天气', phase: 'RUNNING', updatedAt: '2026-11-22 11:30:00' },
    ]);
    const { handler, listRecentSessions: listed, saveMessage } = makeCommandHandler({ listRecentSessions });
    await handler.onMessage({ accountId: 'acc-1', body: '/tasks' } as WeixinInboundMessageContext);
    expect(listed).toHaveBeenCalledWith(1, 5);
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('/tasks 2：先 abort 当前执行再切换，回复确认（D5）', async () => {
    const flag = { value: false, get: () => flag.value, set: (v: boolean) => { flag.value = v; } };
    const switchSession = vi.fn(async () => ({ outcome: 'SWITCHED', session: { id: 32, userId: 1, status: 'ACTIVE' } }));
    const listRecentSessions = vi.fn(async () => [
      { id: 100, title: '甲', phase: null, updatedAt: null },
      { id: 32, title: '乙任务', phase: null, updatedAt: null },
    ]);
    const { handler, switchSession: switched, closeByConversation } = makeCommandHandler({ cancelFlag: flag, switchSession, listRecentSessions });
    const reply = await handler.onMessage({ accountId: 'acc-1', body: '/tasks 2' } as WeixinInboundMessageContext);
    expect(flag.value).toBe(true);
    expect(closeByConversation).toHaveBeenCalledWith(100);
    expect(switched).toHaveBeenCalledWith(1, 32);
    expect(reply?.text).toBe('已切换到「乙任务」，后续消息将以该会话上下文为准。');
  });

  it('/tasks 2 目标即当前：回复已在当前会话，不 abort 不切换', async () => {
    const flag = { value: false, get: () => flag.value, set: (v: boolean) => { flag.value = v; } };
    const switchSession = vi.fn(async () => ({ outcome: 'SWITCHED' }) as never);
    const listRecentSessions = vi.fn(async () => [{ id: 100, title: '甲', phase: null, updatedAt: null }]);
    const { handler, switchSession: switched, closeByConversation } = makeCommandHandler({ cancelFlag: flag, switchSession, listRecentSessions });
    await handler.onMessage({ accountId: 'acc-1', body: '/tasks 1' } as WeixinInboundMessageContext);
    expect(flag.value).toBe(false);
    expect(closeByConversation).not.toHaveBeenCalled();
    expect(switched).not.toHaveBeenCalled();
  });

  it('/help：命令一览；非命令文本仍走原链路（abort 语义不变）', async () => {
    const help = makeCommandHandler({});
    const reply = await help.handler.onMessage({ accountId: 'acc-1', body: '/help' } as WeixinInboundMessageContext);
    expect(reply?.text).toContain('/tasks <序号> 切换到对应任务');
    expect(help.saveMessage).not.toHaveBeenCalled();

    const normal = makeCommandHandler({ cancelFlag: null });
    await normal.handler.onMessage({ accountId: 'acc-1', body: '/tasks 帮我查天气' } as WeixinInboundMessageContext);
    // 未命中：既有「新消息打断旧执行」语义不变（abort 会关 shell），消息照常落库执行。
    expect(normal.closeByConversation).toHaveBeenCalledWith(100);
    expect(normal.saveMessage).toHaveBeenCalledTimes(1);
    expect(normal.prepareMessage).toHaveBeenCalledTimes(1);
  });
});
