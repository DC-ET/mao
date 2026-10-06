import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, createScheduledLiveExecution, type WsHandlerDeps } from './streaming-ws-handler.js';
import type { WsEvent } from './ws-event.js';
import type { Session } from '../../domain/types.js';
import type { WsSocket } from './streaming-ws-registry.js';
import { StreamingWsRegistry, WS_OPEN } from './streaming-ws-registry.js';

class CapturingExecutor {
  readonly tasks: Array<() => void | Promise<void>> = [];
  submit(fn: () => void | Promise<void>): unknown {
    this.tasks.push(fn);
    return fn;
  }
  async runAll(): Promise<void> {
    while (this.tasks.length > 0) {
      const fn = this.tasks.shift()!;
      await fn();
    }
  }
}

function session(mode: string, phase: string): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: mode, phase,
    permissionLevel: 'READ_ONLY', status: 'ACTIVE',
  };
}

function message(id: number, role: string) {
  return { id, sessionId: 11, role, content: 'content' };
}

describe('StreamingWsHandler', () => {
  const executor = new CapturingExecutor();
  const registry = {
    isConnectionAuthorized: vi.fn(() => true), sendToConnection: vi.fn(),
    closeConnection: vi.fn((socket: WsSocket, reason: string) => socket.close(1003, reason)),
    getUserId: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    register: vi.fn(), unregister: vi.fn(), hasLocalClientConnection: vi.fn(),
    sendToLocalClients: vi.fn(), getActiveToolCalls: vi.fn(() => []), clearActiveToolCalls: vi.fn(),
    isSessionThinking: vi.fn(() => false), setSessionThinking: vi.fn(),
    getSessionExecution: vi.fn(() => undefined), setSessionExecution: vi.fn(), clearSessionExecution: vi.fn(),
    getClientType: vi.fn(() => 'browser'), bindEmbedSession: vi.fn(), unbindEmbedSession: vi.fn(),
    getEmbedSessionsForConnection: vi.fn(() => []), getEmbedSessionConnection: vi.fn(() => null),
    getEmbedSessionBinding: vi.fn(() => null),
  };
  const titleService = { scheduleForFirstUserMessage: vi.fn() };
  const harnessService = { prepareMessage: vi.fn(), executeFromEvent: vi.fn(), executePrepared: vi.fn(), executeSideFirstMessage: vi.fn(), forkParentMessages: vi.fn() };
  const sessionService = {
    getSession: vi.fn(), saveMessage: vi.fn(), updatePhase: vi.fn(), updateField: vi.fn(),
    updateModelId: vi.fn(), getMessages: vi.fn(), editMessageAndTruncate: vi.fn(), save: vi.fn(),
    findOwnedMessage: vi.fn(async () => null),
    listSubagentSessions: vi.fn(async () => []),
    cleanupIncompleteTail: vi.fn(async () => 0), updateContextTokens: vi.fn(),
    getLastUserMessage: vi.fn(async () => message(3, 'USER')),
    deleteMessageById: vi.fn(async () => undefined),
  };
  const taskTerminalService = { finishExecution: vi.fn() };
  const onScheduledTaskQueueConsumed = vi.fn(async () => undefined);
  const messageQueueService = {
    listPending: vi.fn(async () => []), enqueue: vi.fn(), dequeue: vi.fn(), getById: vi.fn(),
    delete: vi.fn(), moveToIndex: vi.fn(), enqueueHead: vi.fn(async () => undefined),
  };
  const localToolSessionRegistry = {
    setUserForSession: vi.fn(), isConnected: vi.fn(), failAllForSession: vi.fn(), failAllForUser: vi.fn(),
    completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
  };
  const embedPageToolRegistry = {
    request: vi.fn(), complete: vi.fn(() => true), failSession: vi.fn(), isEmbedSession: vi.fn(() => false),
    hasBoundConnection: vi.fn(() => false), pendingCount: vi.fn(() => 0),
  };
  const askUserQuestionsRegistry = {
    failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []), complete: vi.fn(),
  };
  const treeSignalPublisher = { publishIfSideTask: vi.fn(), publishForSession: vi.fn() };
  const approvalRegistry = { unregister: vi.fn() };
  const activityService = { record: vi.fn() };
  const activityHeartbeat = { touch: vi.fn(), clear: vi.fn() };
  const sessionTodoMapper = { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) };
  const agentLoop = {
    registerCancelFlag: vi.fn(() => { let v = false; return { get: () => v, set: (n: boolean) => { v = n; } }; }),
    removeCancelFlag: vi.fn(), requestCancel: vi.fn(),
    getCancelFlag: vi.fn(() => undefined),
  };
  const shellSessionManager = { closeByConversation: vi.fn() };
  const skillSyncService = { syncToSession: vi.fn(), getRemovedSkillNames: vi.fn(() => []) };
  const localSkillRegistry = { report: vi.fn(), clear: vi.fn() };
  const localAgentsMdRegistry = { report: vi.fn(), clear: vi.fn() };
  const mcpSyncService = {
    loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})),
    clearSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn(),
  };
  const mcpClientManager = { closeSession: vi.fn() };
  const agentMapper = { selectById: vi.fn(async () => ({ id: 5, name: 'Coder' })) };
  const llmModelMapper = { selectById: vi.fn(), selectDefault: vi.fn() };
  const authMetadata = { userId: 7, expiresAt: Date.now() + 60_000 };
  const jwtService = { getAccessTokenMetadata: vi.fn<typeof import('../../crypto/jwt.service.js').JwtService.prototype.getAccessTokenMetadata>() };
  const ws: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };

  const handler = new StreamingWsHandler({
    registry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
    onScheduledTaskQueueConsumed,
    localToolSessionRegistry, askUserQuestionsRegistry, embedPageToolRegistry, treeSignalPublisher, approvalRegistry, activityService,
    activityHeartbeat, sessionTodoMapper, agentLoop, shellSessionManager, skillSyncService,
    localSkillRegistry, localAgentsMdRegistry, mcpSyncService, mcpClientManager, agentMapper,
    llmModelMapper, jwtService, agentExecutor: (fn) => executor.submit(fn), mcpSyncTimeoutSeconds: 60,
  } as unknown as WsHandlerDeps);

  it('sendMessagePersistsUserMessageAndRunsCloudExecution', async () => {
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('event-1');
    messageQueueService.listPending.mockResolvedValue([]);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hello', eventId: 'event-1' } }));
    await executor.runAll();
    expect(sessionService.saveMessage).toHaveBeenCalled();
    expect(titleService.scheduleForFirstUserMessage).toHaveBeenCalledWith(11, 99, 'hello');
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'user_message_saved',
      sessionId: 11,
      data: expect.objectContaining({
        tempEventId: 'event-1',
        messageId: 99,
        source: 'desktop',
        content: 'hello',
      }),
    }));
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(skillSyncService.syncToSession).toHaveBeenCalled();
    expect(harnessService.executeFromEvent).toHaveBeenCalled();
    expect(sessionService.updatePhase).toHaveBeenCalledWith(11, 'RUNNING');
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'event-1');
    expect(activityHeartbeat.clear).toHaveBeenCalledWith(11);
    expect(agentLoop.removeCancelFlag).toHaveBeenCalledWith(11);
  });

  it('finishes an accepted CLOUD task after its SSO connection expires', async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const realRegistry = new StreamingWsRegistry();
    const socket: WsSocket = { id: 'accepted-task', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    const taskExecutor = new CapturingExecutor();
    const taskHandler = new StreamingWsHandler({
      registry: realRegistry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
      localToolSessionRegistry, askUserQuestionsRegistry, embedPageToolRegistry, treeSignalPublisher, approvalRegistry, activityService,
      activityHeartbeat, sessionTodoMapper, agentLoop, shellSessionManager, skillSyncService,
      localSkillRegistry, localAgentsMdRegistry, mcpSyncService, mcpClientManager, agentMapper,
      llmModelMapper, jwtService, agentExecutor: (fn) => taskExecutor.submit(fn),
    } as unknown as WsHandlerDeps);
    try {
      realRegistry.register(socket, 7, 'embed', { userId: 7, authSource: 'company_sso', expiresAt: Date.now() + 1000 });
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
      sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
      harnessService.prepareMessage.mockResolvedValue('accepted-event');
      messageQueueService.listPending.mockResolvedValue([]);
      await taskHandler.handleTextMessage(socket, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'continue in background' } }));
      expect(taskExecutor.tasks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.close).toHaveBeenCalledWith(1003, 'Authentication expired');
      taskHandler.afterConnectionClosed(socket);
      await taskExecutor.runAll();
      expect(harnessService.executeFromEvent).toHaveBeenCalled();
      expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'accepted-event');
      expect(agentLoop.requestCancel).not.toHaveBeenCalled();
    } finally {
      realRegistry.shutdown();
      vi.useRealTimers();
    }
  });

  it('subscribe sends a terminal snapshot so reconnecting clients can reconcile missed completion', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));

    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));

    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_snapshot', sessionId: 11, data: { phase: 'COMPLETED' },
    }));
  });

  it('subscribe snapshot carries the recovered execution id registered on the registry', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    // 崩溃恢复的执行不经 WS handler 提交，只登记在 registry（listener 构造时写入）
    registry.getSessionExecution.mockReturnValueOnce('exec-recovered');

    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));

    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_snapshot', sessionId: 11,
      data: expect.objectContaining({ phase: 'RUNNING', executionId: 'exec-recovered' }),
    }));
  });

  it('cancel aborts a recovered execution whose cancel flag lives on agentLoop instead of handler bookkeeping', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    registry.getSessionExecution.mockReturnValueOnce('exec-recovered');
    const flag = { get: () => false, set: vi.fn() };
    agentLoop.getCancelFlag.mockReturnValueOnce(flag);

    await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));

    // 恢复执行不在 handler.cancelFlags 簿记里，但 flag 已注册在 agentLoop：必须真正中止执行，
    // 不能落进 pendingCancels（无人消费，执行照跑）。
    expect(agentLoop.requestCancel).toHaveBeenCalledWith(11);
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'CANCELLED', 'exec-recovered');
  });

  it('sendMessageRejectsDuplicateWhileSessionIsRunningWithoutPersistingOrSubmitting', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'continue' } }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_already_running',
      data: expect.objectContaining({ code: 'session_already_running' }),
    }));
    expect(sessionService.saveMessage).not.toHaveBeenCalled();
    expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
  });

  it('releases the execution claim when the agent executor rejects the task', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('event-reject');
    messageQueueService.listPending.mockResolvedValue([]);
    const submit = vi.spyOn(executor, 'submit').mockImplementationOnce(() => {
      throw new Error('Agent executor rejected: active=100 queued=200');
    });

    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'busy' } }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({ message: '服务器繁忙，请稍后重试' }),
    }));
    expect(agentLoop.removeCancelFlag).toHaveBeenCalledWith(11);

    // 占位已回滚：同一会话必须还能重新发起执行
    registry.send.mockClear();
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'retry' } }));
    expect(registry.send).not.toHaveBeenCalledWith(7, expect.objectContaining({ type: 'session_already_running' }));
    expect(submit).toHaveBeenCalledTimes(2);
    submit.mockRestore();
    // 让重试的执行跑完，否则 claim 会残留到后续用例
    await executor.runAll();
  });

  it('rejects send_message while session is CANCELLING', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'CANCELLING'));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'continue' } }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_already_running',
    }));
    expect(sessionService.saveMessage).not.toHaveBeenCalled();
  });

  it('marks side session failed when the agent executor rejects the task', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    const submit = vi.spyOn(executor, 'submit').mockImplementationOnce(() => {
      throw new Error('Agent executor rejected: active=100 queued=200');
    });

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'side work', contextMode: 'summary' },
    }));

    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(
      13, 7, 'FAILED', expect.any(String), '服务器繁忙，请稍后重试',
    );
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error',
      sessionId: 13,
      data: expect.objectContaining({ message: '服务器繁忙，请稍后重试' }),
    }));
    submit.mockRestore();
  });

  it('does not start a side task when cancel arrives during fork', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    let releaseFork: () => void = () => {};
    harnessService.forkParentMessages.mockReturnValue(new Promise<void>((resolve) => { releaseFork = resolve; }));

    const creating = handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'side work', contextMode: 'fork' },
    }));
    await vi.waitFor(() => expect(harnessService.forkParentMessages).toHaveBeenCalledWith(11, 13, null));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 13 }));
    releaseFork();
    await creating;
    await executor.runAll();

    expect(harnessService.executeSideFirstMessage).not.toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(13, 7, 'CANCELLED', expect.any(String));
  });

  it('rejects a side fork whose cut point no longer belongs to the parent', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.findOwnedMessage.mockResolvedValue(null);

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11,
      data: { content: 'side work', contextMode: 'fork', forkFromMessageId: 77 },
    }));

    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error',
      sessionId: 11,
      data: expect.objectContaining({
        message: '分叉来源消息不存在或已被删除，请刷新后重试',
        code: 'side_session_rejected',
      }),
    }));
    // 校验前置到建会话之前：不留下空边路任务，也不发 side_session_created
    expect(sessionService.save).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalledWith(7, expect.objectContaining({ type: 'side_session_created' }));
    expect(harnessService.forkParentMessages).not.toHaveBeenCalled();
  });

  it('passes a valid cut point through to forkParentMessages', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    sessionService.findOwnedMessage.mockResolvedValue(message(77, 'ASSISTANT'));

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11,
      data: { content: 'side work', contextMode: 'fork', forkFromMessageId: 77 },
    }));
    await executor.runAll();

    expect(sessionService.findOwnedMessage).toHaveBeenCalledWith(11, 77);
    expect(harnessService.forkParentMessages).toHaveBeenCalledWith(11, 13, 77);
  });

  it('treats a malformed cut point as a full fork', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11,
      data: { content: 'side work', contextMode: 'fork', forkFromMessageId: -3 },
    }));
    await executor.runAll();

    expect(sessionService.findOwnedMessage).not.toHaveBeenCalled();
    expect(harnessService.forkParentMessages).toHaveBeenCalledWith(11, 13, null);
  });

  // ---- 父会话为边路任务（边路的边路，任意深度）：创建链路按父会话抽象，不做类型门槛 ----

  function sideParentSession(mode: string, phase: string): Session {
    const parent = session(mode, phase);
    parent.sessionType = 'SIDE_TASK';
    parent.parentSessionId = 1;
    parent.workspace = '/tmp/parent-ws';
    parent.permissionLevel = 'READ_WRITE';
    return parent;
  }

  it('creates a side task under a side-task parent and inherits its fields', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    const parent = sideParentSession('CLOUD', 'COMPLETED');
    sessionService.getSession.mockResolvedValue(parent);
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'nested side work', contextMode: 'none' },
    }));
    await executor.runAll();

    // 创建成功：新会话仍是 SIDE_TASK，父指向来源边路会话 11，字段继承来源边路
    const saved = sessionService.save.mock.calls[0][0] as Session;
    expect(saved.sessionType).toBe('SIDE_TASK');
    expect(saved.parentSessionId).toBe(11);
    expect(saved.agentId).toBe(5);
    expect(saved.executionMode).toBe('CLOUD');
    expect(saved.workspace).toBe('/tmp/parent-ws');
    expect(saved.permissionLevel).toBe('READ_WRITE');
    // 创建事件与订阅按来源边路会话为键
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'side_session_created', sessionId: 11,
      data: expect.objectContaining({ sideSessionId: 13 }),
    }));
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(harnessService.forkParentMessages).not.toHaveBeenCalled();
    expect(harnessService.executeSideFirstMessage).toHaveBeenCalledWith(11, 13, 'none', expect.anything(), expect.anything());
  });

  it('forks a side task under a side-task parent honoring the cut point', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(sideParentSession('CLOUD', 'COMPLETED'));
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    sessionService.findOwnedMessage.mockResolvedValue({ ...message(77, 'ASSISTANT'), sessionId: 11 });

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11,
      data: { content: 'nested fork', contextMode: 'fork', forkFromMessageId: 77 },
    }));
    await executor.runAll();

    // 切点校验与 fork 复制均以来源边路会话为源
    expect(sessionService.findOwnedMessage).toHaveBeenCalledWith(11, 77);
    expect(harnessService.forkParentMessages).toHaveBeenCalledWith(11, 13, 77);
  });

  it('rejects a side task under a side-task parent when local client is offline', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    registry.hasLocalClientConnection.mockReturnValue(false);
    sessionService.getSession.mockResolvedValue(sideParentSession('LOCAL', 'COMPLETED'));

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'nested local', contextMode: 'none' },
    }));

    expect(sessionService.save).not.toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error',
      sessionId: 11,
      data: expect.objectContaining({ code: 'side_session_rejected' }),
    }));
  });

  it('sendMessageRejectsUnsupportedImagesAndDisconnectedLocalClient', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    const cloud = session('CLOUD', 'IDLE');
    cloud.modelId = 2;
    sessionService.getSession.mockResolvedValue(cloud);
    llmModelMapper.selectById.mockResolvedValue({ supportsVision: 0 });
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hello', images: ['img'] } }));
    expect(registry.send).toHaveBeenCalled();
    expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'IDLE'));
    localToolSessionRegistry.isConnected.mockReturnValue(false);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 12, data: { content: 'hello' } }));
    expect(localToolSessionRegistry.setUserForSession).toHaveBeenCalledWith(12, 7);
  });

  it('releases the execution claim when the local client is disconnected', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'IDLE'));
    localToolSessionRegistry.isConnected.mockReturnValue(false);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 12, data: { content: 'hello' } }));
    // 第二次发送必须仍停在同一个 LOCAL 断连出口：若变成 session_already_running，
    // 说明第一次早退时 claim 未释放，该会话后续发送会被永久拒绝（只能重启后端恢复）。
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 12, data: { content: 'hello again' } }));
    const notConnected = {
      type: 'error', sessionId: 12,
      data: expect.objectContaining({ message: 'Local client is not connected. Please ensure the desktop app is running.' }),
    };
    expect(registry.send).toHaveBeenCalledTimes(2);
    expect(registry.send).toHaveBeenNthCalledWith(1, 7, notConnected);
    expect(registry.send).toHaveBeenNthCalledWith(2, 7, notConnected);
    expect(registry.send).not.toHaveBeenCalledWith(7, expect.objectContaining({ type: 'session_already_running' }));
    expect(sessionService.saveMessage).not.toHaveBeenCalled();
  });

  it('editAndResendRejectsInvalidImagesBeforeTruncatingHistory', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.getMessages.mockResolvedValue([message(3, 'USER')]);
    llmModelMapper.selectDefault.mockResolvedValue({ supportsVision: 0 });
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'edit_and_resend', sessionId: 11, messageId: 3, content: 'edited', images: ['img'],
    }));
    expect(sessionService.editMessageAndTruncate).not.toHaveBeenCalled();
    expect(harnessService.prepareMessage).not.toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error', data: expect.objectContaining({ message: '当前模型不支持图片输入，请切换支持视觉的模型' }),
    }));
  });

  it('editAndResendRejectsTooManyImagesBeforeTruncatingHistory', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.getMessages.mockResolvedValue([message(3, 'USER')]);
    llmModelMapper.selectDefault.mockResolvedValue({ supportsVision: 1 });
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'edit_and_resend', sessionId: 11, messageId: 3, content: 'edited', images: Array(11).fill('img'),
    }));
    expect(sessionService.editMessageAndTruncate).not.toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error', data: expect.objectContaining({ message: '单条消息最多支持 10 张图片' }),
    }));
  });

  it('editAndResendValidatesLastUserMessageAndRunsExecution', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    sessionService.getMessages.mockResolvedValue([message(1, 'USER'), message(2, 'ASSISTANT'), message(3, 'USER')]);
    sessionService.editMessageAndTruncate.mockResolvedValue(message(3, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('edit-event');
    messageQueueService.listPending.mockResolvedValue([]);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'edit_and_resend', sessionId: 11, messageId: 3, content: 'edited' }));
    await executor.runAll();
    expect(sessionService.editMessageAndTruncate).toHaveBeenCalledWith(11, 3, 'edited', []);
    expect(harnessService.executeFromEvent).toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'edit-event');
  });

  it('queueAndToolMessagesAreRoutedToCollaborators', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    const queue = { id: 4, sessionId: 11, content: 'queued', sortOrder: 1, images: '["img"]', createdAt: '2026-07-07T10:00:00' };
    messageQueueService.listPending.mockResolvedValue([queue]);
    messageQueueService.getById.mockResolvedValue(queue);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'unsubscribe', sessionId: 11 }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'enqueue_message', sessionId: 11, data: { content: 'queued', images: ['img'] } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'delete_queue_message', sessionId: 11, data: { queueId: 4 } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'reorder_queue_message', sessionId: 11, data: { queueId: 4, targetIndex: 0 } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_result', sessionId: 11, requestId: 'req', result: 'ok' }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_error', sessionId: 11, requestId: 'req', error: 'bad' }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_approval', sessionId: 11, requestId: 'req', approved: true }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'ask_user_questions_result', sessionId: 11, data: { requestId: 'q', answers: [{ id: 'a' }] } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'ping' }));
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(registry.unsubscribe).toHaveBeenCalledWith(7, 11);
    expect(messageQueueService.enqueue).toHaveBeenCalledWith(11, 7, 'queued', '["img"]');
    expect(messageQueueService.delete).toHaveBeenCalledWith(4);
    expect(messageQueueService.moveToIndex).toHaveBeenCalledWith(4, 0);
    expect(localToolSessionRegistry.completeToolRequest).toHaveBeenCalledWith(11, 'req', 'ok');
    expect(localToolSessionRegistry.completeToolRequestError).toHaveBeenCalledWith(11, 'req', 'bad');
    expect(approvalRegistry.unregister).toHaveBeenCalledWith(11, 'req');
    expect(treeSignalPublisher.publishForSession).toHaveBeenCalledWith(11);
    expect(askUserQuestionsRegistry.complete).toHaveBeenCalledWith(11, 'q', '{"answers":[{"id":"a"}]}');
  });

  it('reorderQueueMessageIgnoresInvalidTargetIndex', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    for (const targetIndex of [-1, 1.5, 'x']) {
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'reorder_queue_message', sessionId: 11, data: { queueId: 4, targetIndex } }));
    }
    expect(messageQueueService.moveToIndex).not.toHaveBeenCalled();
  });

  it('subscribeSendsSnapshotForWaitingApproval', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'WAITING_APPROVAL'));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(localToolSessionRegistry.setUserForSession).toHaveBeenCalledWith(11, 7);
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_snapshot', sessionId: 11, data: expect.objectContaining({ phase: 'WAITING_APPROVAL' }),
    }));
  });

  it('subscribeSnapshotIncludesThinkingWhileModelIsThinking', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    registry.isSessionThinking.mockReturnValue(true);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_snapshot', sessionId: 11,
      data: expect.objectContaining({ phase: 'RUNNING', thinking: true }),
    }));
  });

  it('subscribeSnapshotOmitsThinkingOutsideThinkingPhase', async () => {
    vi.clearAllMocks();
    registry.isSessionThinking.mockReturnValue(false);
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    const snapshot = vi.mocked(registry.send).mock.calls
      .map((c) => c[1] as { type: string; data?: Record<string, unknown> })
      .find((e) => e.type === 'session_snapshot');
    expect(snapshot?.data).not.toHaveProperty('thinking');
  });

  it('sessionOperationsRejectNonOwner', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    const foreign = session('CLOUD', 'RUNNING');
    foreign.userId = 99;
    sessionService.getSession.mockResolvedValue(foreign);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hello' } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'enqueue_message', sessionId: 11, data: { content: 'queued' } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_result', sessionId: 11, requestId: 'req', result: 'ok' }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
    expect(messageQueueService.enqueue).not.toHaveBeenCalled();
    expect(localToolSessionRegistry.completeToolRequest).not.toHaveBeenCalled();
    expect(registry.subscribe).not.toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).not.toHaveBeenCalled();
    const errorCalls = vi.mocked(registry.send).mock.calls.filter((c) => (c[1] as WsEvent).type === 'error');
    expect(errorCalls).toHaveLength(5);
  });

  it('createSideSessionSavesChildAndExecutesFirstMessage', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    const parent = session('CLOUD', 'IDLE');
    parent.workspace = '/repo';
    parent.projectKey = 'repo';
    sessionService.getSession.mockResolvedValue(parent);
    sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
    sessionService.save.mockImplementation(async (s: Session) => { s.id = 13; });
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'side work', contextMode: 'summary', modelId: 9 },
    }));
    await executor.runAll();
    expect(sessionService.save).toHaveBeenCalledWith(expect.objectContaining({
      workspace: '/repo',
      projectKey: 'repo',
      parentSessionId: 11,
      sessionType: 'SIDE_TASK',
    }));
    expect(sessionService.saveMessage).toHaveBeenCalledWith(13, 'USER', 'side work', null, null, null, 0, null);
    expect(titleService.scheduleForFirstUserMessage).toHaveBeenCalledWith(13, 99, 'side work');
    const createdCallOrder = vi.mocked(registry.send).mock.invocationCallOrder.find((_, index) => {
      const event = vi.mocked(registry.send).mock.calls[index]?.[1] as WsEvent;
      return event.type === 'side_session_created';
    });
    expect(createdCallOrder).toBeLessThan(titleService.scheduleForFirstUserMessage.mock.invocationCallOrder[0]);
    expect(harnessService.executeSideFirstMessage).toHaveBeenCalled();
  });

  it('createSideSessionRejectsImagesWhenModelLacksVision', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    const parent = session('CLOUD', 'IDLE');
    parent.modelId = 2;
    sessionService.getSession.mockResolvedValue(parent);
    llmModelMapper.selectById.mockResolvedValue({ supportsVision: 0 });
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'look', contextMode: 'summary', images: ['https://cdn.example/a.png'] },
    }));
    expect(sessionService.save).not.toHaveBeenCalled();
    expect(harnessService.executeSideFirstMessage).not.toHaveBeenCalled();
  });

  it('connectionLifecycleUsesTokenAndCleanupHooks', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValueOnce(null).mockReturnValue(7);
    jwtService.getAccessTokenMetadata.mockReturnValue(authMetadata);
    registry.hasLocalClientConnection.mockReturnValue(false);
    const connected: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    await handler.handleTextMessage(connected, JSON.stringify({ type: 'auth', token: 'valid.jwt.token', client: 'electron' }));
    expect(registry.register).toHaveBeenCalledWith(connected, 7, 'electron', authMetadata);
    expect(registry.sendToConnection).toHaveBeenCalledWith(connected, expect.objectContaining({ type: 'connected' }));
    // 已认证连接再次发 auth 应为无害 no-op（不重复注册）
    registry.register.mockClear();
    await handler.handleTextMessage(connected, JSON.stringify({ type: 'auth', token: 'valid.jwt.token', client: 'electron' }));
    expect(registry.register).not.toHaveBeenCalled();
    handler.afterConnectionClosed(connected);
    handler.handleTransportError(connected);
    expect(localToolSessionRegistry.failAllForUser).toHaveBeenCalledTimes(2);
    expect(askUserQuestionsRegistry.failAllForSession).not.toHaveBeenCalled();
  });

  it('closes unauthenticated connections that send non-auth messages', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(null);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    expect(ws.close).toHaveBeenCalledWith(1003, 'Not authenticated');
    expect(registry.subscribe).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('normalizesEmbedClientType', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValueOnce(null).mockReturnValue(7);
    jwtService.getAccessTokenMetadata.mockReturnValue(authMetadata);
    const connected: WsSocket = { id: 'ws-embed', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    // 大小写不敏感归一化为 'embed'
    await handler.handleTextMessage(connected, JSON.stringify({ type: 'auth', token: 'valid.jwt.token', client: 'Embed' }));
    expect(registry.register).toHaveBeenCalledWith(connected, 7, 'embed', authMetadata);
  });

  it('subscribeRePushesPendingAskUserQuestionsOnReconnect', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    askUserQuestionsRegistry.getPendingForSession.mockReturnValue([
      { requestId: 'req-1', questions: [{ question: '如何处理?', header: '方案' }], metadata: { source: 'test' } },
    ]);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'session_snapshot' }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'ask_user_questions',
      data: expect.objectContaining({ requestId: 'req-1', metadata: { source: 'test' } }),
    }));
  });

  it('askUserQuestionsResultBroadcastsDismissWhenCompleted', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    askUserQuestionsRegistry.complete.mockReturnValue(true);
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'ask_user_questions_result', sessionId: 11, data: { requestId: 'q', answers: [{ id: 'a' }] },
    }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'ask_user_questions_cancelled', data: expect.objectContaining({ requestId: 'q' }),
    }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_status', sessionId: 11, data: expect.objectContaining({ phase: 'RUNNING' }),
    }));
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_list_update', sessionId: 11, data: { phase: 'RUNNING' },
    }));
  });

  it('connectionRejectsForgedOrInvalidJwt', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(null);
    jwtService.getAccessTokenMetadata.mockReturnValue(null);
    const connected: WsSocket = { id: 'ws-x', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    await handler.handleTextMessage(connected, JSON.stringify({ type: 'auth', token: 'forged', client: 'browser' }));
    expect(connected.close).toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
    expect(jwtService.getAccessTokenMetadata).toHaveBeenCalledWith('forged');
  });

  it('keeps client=cli instead of silently mapping to browser', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(null);
    jwtService.getAccessTokenMetadata.mockReturnValue(authMetadata);
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'auth', token: 'ok', client: 'cli' }));
    expect(registry.register).toHaveBeenCalledWith(ws, 7, 'cli', authMetadata);
  });

  it('autoConsumesQueuedMessageAfterExecutionCompletes', async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{commit_and_push}#', sortOrder: 1, images: null };
    let pending = [queued];
    messageQueueService.listPending.mockImplementation(async () => pending);
    messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    sessionService.saveMessage.mockResolvedValue(message(100, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('event-2');
    harnessService.executeFromEvent.mockResolvedValue(undefined);
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'send_message', sessionId: 11, data: { content: 'hello', eventId: 'event-1' },
    }));
    const running = executor.runAll();
    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(messageQueueService.dequeue).toHaveBeenCalledWith(11);
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'queue_message_consumed',
      data: expect.objectContaining({ content: '#{commit_and_push}#' }),
    }));
    expect(harnessService.executeFromEvent).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('doesNotAutoConsumeQueueWhenExecutionFails', async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));
    messageQueueService.listPending.mockResolvedValue([
      { id: 8, sessionId: 11, userId: 7, content: '#{do_something}#', sortOrder: 1, images: null },
    ]);
    messageQueueService.dequeue.mockResolvedValue(
      { id: 8, sessionId: 11, userId: 7, content: '#{do_something}#', sortOrder: 1, images: null },
    );
    sessionService.saveMessage.mockResolvedValue(message(100, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('event-1');
    harnessService.executeFromEvent.mockRejectedValue(new Error('boom'));
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'send_message', sessionId: 11, data: { content: 'hello', eventId: 'event-1' },
    }));
    const running = executor.runAll();
    await vi.advanceTimersByTimeAsync(500);
    await running;
    // FAILED 后不应自动出队/消费队列下一条
    expect(messageQueueService.dequeue).not.toHaveBeenCalled();
    expect(messageQueueService.listPending).not.toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'FAILED', 'event-1', expect.any(String));
    vi.useRealTimers();
  });

  it('autoConsumesQueueWhenExecutionCancelled', async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));
    let pending = [
      { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null },
    ];
    messageQueueService.listPending.mockImplementation(async () => pending);
    messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    sessionService.saveMessage.mockResolvedValue(message(100, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('event-1');
    // 模拟执行中被取消：置位 cancelFlag，使 runExecution 走 CANCELLED 收尾。
    harnessService.executeFromEvent.mockImplementation(async (_s: number, _e: string, _l: unknown, flag?: { set(v: boolean): void }) => {
      flag?.set?.(true);
    });
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'send_message', sessionId: 11, data: { content: 'hello', eventId: 'event-1' },
    }));
    const running = executor.runAll();
    await vi.advanceTimersByTimeAsync(500);
    await running;
    // CANCELLED 属用户主动决策：结束后照常自动消费下一条
    expect(messageQueueService.dequeue).toHaveBeenCalledWith(11);
    vi.useRealTimers();
  });

  it('deletes the auto-saved user message when the executor rejects the auto-consumed task', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null };
    let pending = [queued];
    messageQueueService.listPending.mockImplementation(async () => pending);
    messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    sessionService.saveMessage.mockResolvedValue(message(100, 'USER'));
    const submit = vi.spyOn(executor, 'submit').mockImplementationOnce(() => {
      throw new Error('Agent executor rejected: active=100 queued=200');
    });
    try {
      await handler.autoConsumeQueue(11, 7);
    } finally {
      submit.mockRestore();
    }
    // 回补队首的同时必须删掉已落库的 USER，否则下次消费会重复落库同一条消息
    expect(messageQueueService.enqueueHead).toHaveBeenCalledWith(11, 7, '#{next}#', null, null, null, null);
    expect(sessionService.deleteMessageById).toHaveBeenCalledWith(11, 100);
  });

  it('rolls back the dequeued message when broadcasting the consumed event fails', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));
    let pending = [{ id: 9, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null }];
    messageQueueService.listPending.mockImplementation(async () => pending);
    messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    sessionService.saveMessage.mockResolvedValue(message(101, 'USER'));
    registry.send.mockImplementationOnce(() => undefined) // queue_updated
      .mockImplementationOnce(() => { throw new Error('socket gone'); }); // queue_message_consumed
    try {
      await handler.autoConsumeQueue(11, 7);
    } finally {
      registry.send.mockReset();
    }
    expect(messageQueueService.enqueueHead).toHaveBeenCalledWith(11, 7, '#{next}#', null, null, null, null);
    expect(sessionService.deleteMessageById).toHaveBeenCalledWith(11, 101);
  });

  it('does not write a CANCELLED terminal phase when the session is idle', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
    // 空闲会话没有在途执行：只回 pending 取消，不得把 IDLE 落成 CANCELLED
    expect(taskTerminalService.finishExecution).not.toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'cancelled',
      data: expect.objectContaining({ pending: true }),
    }));
  });

  it('cancel insert skillSync mcpReport and sideTask', async () => {
    vi.clearAllMocks();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
    expect(taskTerminalService.finishExecution).toHaveBeenCalled();

    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.getById.mockResolvedValue({ id: 4, sessionId: 11, content: 'inserted', images: null });
    sessionService.saveMessage.mockResolvedValue(message(50, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('ins-event');
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'insert_message', sessionId: 11, data: { queueId: 4 } }));
    await executor.runAll();

    await handler.handleTextMessage(ws, JSON.stringify({ type: 'skill_sync_done', sessionId: 11, success: true }));
    mcpSyncService.resolveServerIdByName.mockReturnValue(3);
    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'mcp_tools_report', sessionId: 11, syncId: 'sync-1',
      servers: [{ connected: true, name: 'fs', tools: [{ name: 'read', description: 'd', schema: {} }] }],
    }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel_side_task', sideSessionId: 11 }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'unknown_type' }));
    await handler.handleTextMessage(ws, 'not-json');
  });

  it('executePersistedUserPromptPushesScheduledUserMessageAndStreams', async () => {
    vi.clearAllMocks();
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.listPending.mockResolvedValue([]);
    harnessService.executeFromEvent.mockResolvedValue(undefined);
    await handler.executePersistedUserPrompt(
      session('CLOUD', 'IDLE'), 7, 'sched-1', { id: 88, content: '定时检查' },
    );
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'user_message_saved',
      sessionId: 11,
      data: expect.objectContaining({ source: 'scheduled', messageId: 88, content: '定时检查' }),
    }));
    expect(titleService.scheduleForFirstUserMessage).toHaveBeenCalledWith(11, 88, '定时检查');
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(harnessService.executeFromEvent).toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'sched-1');
  });

  it('executePersistedUserPromptPushesScheduledUserMessageAndStreamsWithoutSource', async () => {
    // 兼容断言：未传 scheduledTaskId 时保持 5 参调用（MANUAL 语义）
    vi.clearAllMocks();
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.listPending.mockResolvedValue([]);
    harnessService.executeFromEvent.mockResolvedValue(undefined);
    await handler.executePersistedUserPrompt(
      session('CLOUD', 'IDLE'), 7, 'sched-plain', { id: 89, content: '手工触发' }, undefined, null,
    );
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'sched-plain');
  });

  it('scheduledLiveExecutionPassesScheduledSourceToFinishExecution (收件箱来源透传)', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.listPending.mockResolvedValue([]);
    harnessService.executeFromEvent.mockResolvedValue(undefined);
    // 定时任务生产路径：liveExecution 传入 taskId → 收件箱条目必须具备「定时任务」来源。
    // TS 窄接口无告警，缺参会静默回落 MANUAL，因此此处必须显式断言第 6 参 = 'SCHEDULED'。
    await handler.executePersistedUserPrompt(
      session('CLOUD', 'IDLE'), 7, 'sched-2', { id: 90, content: '定时任务' }, undefined, 42,
    );
    await executor.runAll();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'COMPLETED', 'sched-2', undefined, 'SCHEDULED',
    );
  });

  it('scheduledLiveExecutionFailureAlsoCarriesScheduledSource', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.listPending.mockResolvedValue([]);
    harnessService.executeFromEvent.mockRejectedValue(new Error('boom'));
    await handler.executePersistedUserPrompt(
      session('CLOUD', 'IDLE'), 7, 'sched-3', { id: 91, content: '定时任务' }, undefined, 43,
    );
    await executor.runAll();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'FAILED', 'sched-3', expect.any(String), 'SCHEDULED',
    );
  });

  it('scheduledBindingIsScopedToItsOwnExecution（迟到执行体不串味）', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.listPending.mockResolvedValue([]);
    harnessService.executeFromEvent.mockResolvedValue(undefined);
    // 先跑一次手工执行（无来源），再跑一次定时任务执行：手工执行不得继承 SCHEDULED
    await handler.executePersistedUserPrompt(
      session('CLOUD', 'IDLE'), 7, 'manual-1', { id: 92, content: '手工' }, undefined, null,
    );
    await executor.runAll();
    await handler.executePersistedUserPrompt(
      session('CLOUD', 'IDLE'), 7, 'sched-4', { id: 93, content: '定时' }, undefined, 44,
    );
    await executor.runAll();
    const calls = taskTerminalService.finishExecution.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][5]).toBeUndefined();
    expect(calls[1][5]).toBe('SCHEDULED');
  });

  it('createScheduledLiveExecution 装配层透传第 6 参（create-app 的 setLiveExecution 同源）', async () => {
    // 生产链路真正的调用点是 create-app.ts 的 setLiveExecution(lambda)；TS 允许形参更少的
    // lambda 赋值给 ScheduledLiveExecution，漏接第 6 参编译零告警、运行期静默丢弃，
    // 后果是所有定时任务条目都缺「定时任务」徽标。此处直接断言唯一装配工厂逐参透传。
    vi.clearAllMocks();
    executor.tasks.length = 0;
    sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
    messageQueueService.listPending.mockResolvedValue([]);
    harnessService.executeFromEvent.mockResolvedValue(undefined);

    const spy = vi.spyOn(handler, 'executePersistedUserPrompt');
    const live = createScheduledLiveExecution(handler);
    expect(live.length).toBe(7); // 形参表与 ScheduledLiveExecution 对齐，防止回归成漏参 lambda

    await live(session('CLOUD', 'IDLE'), 7, 'sched-5', { id: 94, content: '定时任务' }, undefined, 55);
    expect(spy).toHaveBeenCalledWith(
      session('CLOUD', 'IDLE'), 7, 'sched-5', { id: 94, content: '定时任务' }, undefined, 55, undefined,
    );

    await executor.runAll();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'COMPLETED', 'sched-5', undefined, 'SCHEDULED',
    );
  });

  it('localSessionFailsImmediatelyWhenClientReportsSkillSyncWithoutSyncId', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'IDLE'));
    sessionService.saveMessage.mockResolvedValue(message(120, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('local-event');
    localToolSessionRegistry.isConnected.mockResolvedValue(true);
    registry.hasLocalClientConnection.mockReturnValue(true);
    // 旧版客户端（mao-agent ≤ 0.1.2 / 旧桌面端）回报的 skill_sync_done 不带 syncId
    registry.sendToLocalClients.mockImplementationOnce(() => {
      void handler.handleTextMessage(ws, JSON.stringify({ type: 'skill_sync_done', sessionId: 11, success: true }));
    });

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'send_message', sessionId: 11, data: { content: '看下我电脑的硬盘情况' },
    }));
    await executor.runAll();

    expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'FAILED', 'local-event', expect.stringContaining('syncId'),
    );
    expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'error', sessionId: 11,
      data: expect.objectContaining({ message: expect.stringContaining('syncId'), executionId: 'local-event' }),
    }));
    registry.hasLocalClientConnection.mockReset();
    localToolSessionRegistry.isConnected.mockReset();
  });

  it('localSessionFailsWithConnectionReasonWhenNoLocalClientIsRegistered', async () => {
    vi.clearAllMocks();
    executor.tasks.length = 0;
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'IDLE'));
    sessionService.saveMessage.mockResolvedValue(message(121, 'USER'));
    harnessService.prepareMessage.mockResolvedValue('local-event-2');
    localToolSessionRegistry.isConnected.mockResolvedValue(true);
    registry.hasLocalClientConnection.mockReturnValue(false);

    await handler.handleTextMessage(ws, JSON.stringify({
      type: 'send_message', sessionId: 11, data: { content: 'hello' },
    }));
    await executor.runAll();

    expect(registry.sendToLocalClients).not.toHaveBeenCalled();
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'FAILED', 'local-event-2', expect.stringContaining('客户端连接'),
    );
    registry.hasLocalClientConnection.mockReset();
    localToolSessionRegistry.isConnected.mockReset();
  });

  describe('retry_execution for SUBAGENT sessions', () => {
    function subagentSession(mode: string, phase: string): Session {
      return {
        ...session(mode, phase),
        sessionType: 'SUBAGENT',
        parentSessionId: 10,
      };
    }

    function buildManagerMock() {
      return {
        cancelAllForParent: vi.fn(),
        beginRetry: vi.fn(async () => ({ ok: true, taskId: 55 })),
        completeRetry: vi.fn(),
        // 重试上下文走 buildSubContext 裁剪（BUG-2 修复）：WS 侧经 buildRetryContext + executePrepared
        buildRetryContext: vi.fn(async (childSessionId: number) => ({ sessionId: childSessionId })),
      };
    }

    function resetQueue() {
      messageQueueService.listPending.mockResolvedValue([]);
      messageQueueService.dequeue.mockResolvedValue(null);
    }

    function buildSubagentHandler(manager: ReturnType<typeof buildManagerMock>) {
      return new StreamingWsHandler({
        registry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
        localToolSessionRegistry, askUserQuestionsRegistry, embedPageToolRegistry, treeSignalPublisher, approvalRegistry, activityService,
        activityHeartbeat, sessionTodoMapper, agentLoop, shellSessionManager, skillSyncService,
        localSkillRegistry, localAgentsMdRegistry, mcpSyncService, mcpClientManager, agentMapper,
        llmModelMapper, jwtService, agentExecutor: (fn) => executor.submit(fn),
        backgroundSubagentManager: manager,
      } as unknown as WsHandlerDeps);
    }

    it('forwards retry to subagent manager: begin before run and complete with final phase', async () => {
      vi.clearAllMocks();
      executor.tasks.length = 0;
      resetQueue();
      const manager = buildManagerMock();
      const subHandler = buildSubagentHandler(manager);
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(subagentSession('CLOUD', 'FAILED'));
      harnessService.executeFromEvent.mockResolvedValue(undefined);

      await subHandler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));
      await executor.runAll();

      expect(manager.beginRetry).toHaveBeenCalledWith(10, 11);
      expect(manager.buildRetryContext).toHaveBeenCalledWith(11);
      expect(harnessService.executePrepared).toHaveBeenCalled();
      expect(manager.completeRetry).toHaveBeenCalledWith(10, 55, 'COMPLETED');
    });

    it('marks FAILED when retry execution throws', async () => {
      vi.clearAllMocks();
      executor.tasks.length = 0;
      resetQueue();
      const manager = buildManagerMock();
      const subHandler = buildSubagentHandler(manager);
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(subagentSession('CLOUD', 'FAILED'));
      harnessService.executePrepared.mockRejectedValue(new Error('boom'));

      await subHandler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));
      await executor.runAll();

      expect(manager.completeRetry).toHaveBeenCalledWith(10, 55, 'FAILED');
    });

    it('rejects retry when beginRetry fails without running execution', async () => {
      vi.clearAllMocks();
      executor.tasks.length = 0;
      const manager = buildManagerMock();
      manager.beginRetry.mockResolvedValue({ ok: false, error: '任务尚未结束，无法重试' });
      const subHandler = buildSubagentHandler(manager);
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(subagentSession('CLOUD', 'FAILED'));

      await subHandler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));
      await executor.runAll();

      expect(manager.beginRetry).toHaveBeenCalledWith(10, 11);
      expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
      expect(harnessService.executePrepared).not.toHaveBeenCalled();
      expect(manager.completeRetry).not.toHaveBeenCalled();
      expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
        type: 'error', sessionId: 11,
        data: expect.objectContaining({ message: '任务尚未结束，无法重试' }),
      }));
    });

    it('rolls back subagent execution to FAILED when setup fails after beginRetry', async () => {
      vi.clearAllMocks();
      executor.tasks.length = 0;
      resetQueue();
      const manager = buildManagerMock();
      const subHandler = buildSubagentHandler(manager);
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(subagentSession('CLOUD', 'FAILED'));
      // LOCAL 检查失败，模拟 beginRetry 成功后、执行提交前的失败出口
      sessionService.updatePhase.mockRejectedValue(new Error('db down'));

      await subHandler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));
      await executor.runAll();

      expect(manager.completeRetry).toHaveBeenCalledWith(10, 55, 'FAILED');
    });

    it('rejected executor rolls phase back to entry phase instead of staying RESUMING', async () => {
      vi.clearAllMocks();
      executor.tasks.length = 0;
      resetQueue();
      // 线程池饱和：agentExecutor 同步抛拒绝错误
      const rejectingHandler = new StreamingWsHandler({
        registry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
        localToolSessionRegistry, askUserQuestionsRegistry, embedPageToolRegistry, treeSignalPublisher, approvalRegistry, activityService,
        activityHeartbeat, sessionTodoMapper, agentLoop, shellSessionManager, skillSyncService,
        localSkillRegistry, localAgentsMdRegistry, mcpSyncService, mcpClientManager, agentMapper,
        llmModelMapper, jwtService,
        agentExecutor: () => { throw new Error('Agent executor rejected: active=8 queued=50 max=8 queueCapacity=50'); },
      } as unknown as WsHandlerDeps);
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockReset();
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'FAILED'));
      const updatePhaseCalls: Array<[number, string]> = [];
      sessionService.updatePhase.mockReset();
      sessionService.updatePhase.mockImplementation(async (id: number, phase: string) => {
        updatePhaseCalls.push([id, phase]);
      });

      await rejectingHandler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));

      // 相位先推 RESUMING，提交被拒后必须收敛回进入时的终态 FAILED
      expect(updatePhaseCalls).toEqual([[11, 'RESUMING'], [11, 'FAILED']]);
      // 已告知用户「服务器繁忙」，且不能留下执行占位
      expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
        type: 'error', sessionId: 11,
        data: expect.objectContaining({ message: '服务器繁忙，请稍后重试' }),
      }));
      expect(rejectingHandler.hasExecutionClaim(11)).toBe(false);
      expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
      sessionService.updatePhase.mockResolvedValue(undefined);
    });
  });

  describe('page tool bridge', () => {
    it('binds the embed connection when it subscribes to a session', async () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      registry.getClientType.mockReturnValue('embed');
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
      expect(registry.bindEmbedSession).toHaveBeenCalledWith(11, ws);
    });

    it('completes pending page requests only for the bound connection', async () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      registry.getEmbedSessionsForConnection.mockReturnValue([11]);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      embedPageToolRegistry.complete.mockReturnValue(true);
      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'page_tool_result', sessionId: 11, requestId: 'req-1',
        data: { success: true, result: { ok: true }, snapshotId: 's1', pageVersion: 'v2' },
      }));
      expect(embedPageToolRegistry.complete).toHaveBeenCalledWith(11, 'req-1', ws, expect.objectContaining({
        success: true, snapshotId: 's1', pageVersion: 'v2',
      }));
    });

    it('ignores page tool results from a connection that is not bound to the session', async () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      registry.getEmbedSessionsForConnection.mockReturnValue([]);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'page_tool_result', sessionId: 11, requestId: 'req-1', data: { success: true },
      }));
      expect(embedPageToolRegistry.complete).not.toHaveBeenCalled();
    });

    it('fails pending page requests when the embed connection closes', () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      registry.getEmbedSessionsForConnection.mockReturnValue([11, 12]);
      handler.afterConnectionClosed(ws);
      expect(embedPageToolRegistry.failSession).toHaveBeenCalledWith(11, expect.stringContaining('页面连接'), 'embed_client_not_connected');
      expect(embedPageToolRegistry.failSession).toHaveBeenCalledWith(12, expect.stringContaining('页面连接'), 'embed_client_not_connected');
      expect(registry.unregister).toHaveBeenCalledWith(ws);
    });

    it('cancels pending page requests when the user stops the task', async () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
      expect(embedPageToolRegistry.failSession).toHaveBeenCalledWith(11, expect.stringContaining('停止'));
    });

    it('fails pending page requests when the embed connection unsubscribes', async () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      registry.getClientType.mockReturnValue('embed');
      registry.getEmbedSessionsForConnection.mockReturnValue([11]);
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'unsubscribe', sessionId: 11 }));
      expect(embedPageToolRegistry.failSession).toHaveBeenCalledWith(11, expect.stringContaining('取消订阅'), 'embed_client_not_connected');
      expect(registry.unbindEmbedSession).toHaveBeenCalledWith(11, ws);
    });

    it('fails pending page requests when the session is rebound to another embed connection', async () => {
      vi.clearAllMocks();
      registry.getUserId.mockReturnValue(7);
      registry.getClientType.mockReturnValue('embed');
      const other: WsSocket = { id: 'ws-2', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
      registry.getEmbedSessionBinding.mockReturnValue(other);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
      expect(embedPageToolRegistry.failSession).toHaveBeenCalledWith(11, expect.stringContaining('切换'), 'embed_client_not_connected');
      // 旧连接可能仍 OPEN：必须显式通知它中止在途页面动作，避免与新连接重复执行
      expect(registry.sendToConnection).toHaveBeenCalledWith(other, expect.objectContaining({
        type: 'page_tool_cancel', sessionId: 11,
      }));
      expect(registry.bindEmbedSession).toHaveBeenCalledWith(11, ws);
    });
  });

  describe('execution bookkeeping release', () => {
    /**
     * 走一次 send_message 让会话进入执行中。
     * body 返回永不 settle 的 promise 时不能 await（会挂死测试），故用 runToCompletion 控制。
     */
    async function startExecution(phase: string, eventId: string, body: () => Promise<void>, runToCompletion = true) {
      vi.clearAllMocks();
      executor.tasks.length = 0;
      // 前序用例的簿记残留（如 IDLE 会话 cancel 后遗留的 pendingCancels）会让本次发送在
      // takePendingCancel 处被误判取消、claim 未提交即被删。先整体回收，保证与执行时序解耦。
      (handler as unknown as { releaseExecutionBookkeeping: (id: number) => void })
        .releaseExecutionBookkeeping(11);
      // 前序用例可能给 updatePhase 挂了 rejection，这里必须复位，否则 setup 阶段就失败收尾。
      sessionService.updatePhase.mockReset();
      sessionService.updatePhase.mockResolvedValue(undefined);
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(session('CLOUD', phase));
      sessionService.saveMessage.mockResolvedValue(message(99, 'USER'));
      harnessService.prepareMessage.mockResolvedValue(eventId);
      harnessService.executeFromEvent.mockImplementation(body);
      messageQueueService.listPending.mockResolvedValue([]);
      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'hi', eventId },
      }));
      if (runToCompletion) await executor.runAll();
    }

    /** 让会话进入执行中并保持挂起（执行体走不到 finally），模拟 LLM 流卡死。 */
    async function startStuckExecution(phase: string, eventId: string) {
      await startExecution(phase, eventId, () => new Promise<void>(() => { /* never settles */ }), false);
      expect(handler.hasExecutionClaim(11)).toBe(true);
    }

    it('cancel releases the claim even when the execution body never reaches finally', async () => {
      await startStuckExecution('IDLE', 'e-1');

      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));

      // 取消后簿记必须清零，否则该会话后续发送/重试全被 session_already_running 拒绝。
      expect(handler.hasExecutionClaim(11)).toBe(false);
      expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'CANCELLED', 'e-1');
      expect(agentLoop.removeCancelFlag).toHaveBeenCalledWith(11);
    });

    it('execution cancelled while queued converges at entry without clobbering the resent execution', async () => {
      // 发送 A（排队）→ 取消（落 CANCELLED + 释放簿记）→ 立即重发 B → 池依次开跑：
      // A 迟到开跑必须走入口取消复查收敛，不得覆盖 CANCELLED、不得删掉 B 的 claim/flag。
      await startExecution('IDLE', 'e-1', () => new Promise<void>(() => { /* never settles */ }), false);

      sessionService.getSession.mockResolvedValue(session('CLOUD', 'IDLE'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
      expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'CANCELLED', 'e-1');

      // 重发 B：正常执行到完成
      harnessService.executeFromEvent.mockResolvedValue(undefined);
      messageQueueService.listPending.mockResolvedValue([]);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'CANCELLED'));
      sessionService.saveMessage.mockResolvedValue(message(100, 'USER'));
      harnessService.prepareMessage.mockResolvedValue('e-2');
      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'again', eventId: 'e-2' },
      }));
      await executor.runAll();

      // 恰好一次 RUNNING 相位写入（B 的）：A 迟到开跑若没有入口复查，会再写一次 RUNNING
      const runningWrites = vi.mocked(sessionService.updatePhase).mock.calls
        .filter(([id, phase]) => id === 11 && phase === 'RUNNING');
      expect(runningWrites).toHaveLength(1);
      expect(harnessService.executeFromEvent).toHaveBeenCalledTimes(1);
      // B 收尾后自己的簿记被正常回收（A 的迟到 finally 不得提前删掉它）
      expect(handler.hasExecutionClaim(11)).toBe(false);
    });

    it('execution cancelled while queued consumes the next queued message from its entry-converged finally', async () => {
      // 排队窗口取消与上条同构，但队列里还有一条 busy 入队的定时任务消息：
      // 入口复查提前退出后，finally 仍必须完成收敛职责——autoConsumeQueue 出队执行下一条
      // 并回写定时任务终态。预修复时提前 return 在 try 之外，整段 finally 被跳过：
      // 队列消息停滞（要等下一次执行自然结束才被消费）、绑定残留被后续执行 stale 回写。
      // 用独立 sessionId 隔离前置用例可能残留的簿记/会话锁，保证 A 真实入池排队。
      vi.useFakeTimers();
      vi.clearAllMocks();
      executor.tasks.length = 0;
      const own = (phase: string): Session => ({
        id: 15, userId: 7, agentId: 5, executionMode: 'CLOUD', phase,
        permissionLevel: 'READ_ONLY', status: 'ACTIVE',
      });
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(own('IDLE'));
      sessionService.saveMessage.mockResolvedValue(message(100, 'USER'));
      harnessService.prepareMessage.mockResolvedValue('e-own-1');
      harnessService.executeFromEvent.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      messageQueueService.listPending.mockResolvedValue([]);
      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'send_message', sessionId: 15, data: { content: 'hi', eventId: 'e-own-1' },
      }));

      sessionService.getSession.mockResolvedValue(own('IDLE'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 15 }));
      expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(15, 7, 'CANCELLED', 'e-own-1');

      // 队列里还有一条 busy 入队的定时任务消息（A 在途时用户继续入队）
      harnessService.executeFromEvent.mockResolvedValue(undefined);
      const queued = { id: 8, sessionId: 15, userId: 7, content: 'queued-next', sortOrder: 1, images: null, scheduledTaskId: 9 };
      let pending = [queued];
      messageQueueService.listPending.mockImplementation(async () => pending);
      messageQueueService.dequeue.mockImplementation(async () => {
        const head = pending[0] ?? null;
        pending = [];
        return head;
      });
      sessionService.getSession.mockResolvedValue(own('CANCELLED'));
      const running = executor.runAll();
      await vi.advanceTimersByTimeAsync(500);
      await running;
      vi.useRealTimers();

      // A 的入口复查提前退出，但 finally 的 autoConsumeQueue 照常出队、落库并执行下一条
      expect(messageQueueService.dequeue).toHaveBeenCalledWith(15);
      expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
        type: 'queue_message_consumed',
        sessionId: 15,
        data: expect.objectContaining({ content: 'queued-next' }),
      }));
      expect(harnessService.executeFromEvent).toHaveBeenCalled();
      // busy 入队的定时任务绑定被消费并回写终态，不会永久停在 QUEUED 或被后续执行 stale 回写
      expect(onScheduledTaskQueueConsumed).toHaveBeenCalledWith(9, 'CANCELLED');
      // A 迟到开跑不得再写 RUNNING，也不得误删后续执行的簿记
      const runningWrites = vi.mocked(sessionService.updatePhase).mock.calls
        .filter(([id, phase]) => id === 15 && phase === 'RUNNING');
      expect(runningWrites).toHaveLength(1);
      expect(handler.hasExecutionClaim(15)).toBe(false);
    });

    it('liveExecution cancelled in the pre-exec window settles the queued scheduled binding', async () => {
      // BUG-7 回归：executePersistedUserPrompt 的 takePendingCancel 分支原先只清
      // `scheduledTaskIds`（收件箱来源）就 return，漏掉 `queueScheduledTaskIds`
      // （busy 入队回写来源）→ 定时任务 lastExecutionStatus 永久停在 QUEUED，
      // 且残留绑定会被下一次执行 stale 回写。
      // 现两处早退路径 + runExecution finally 共用 settleQueuedScheduledBinding。
      vi.useFakeTimers();
      vi.clearAllMocks();
      executor.tasks.length = 0;
      const own = (phase: string): Session => ({
        id: 16, userId: 7, agentId: 5, executionMode: 'CLOUD', phase,
        permissionLevel: 'READ_ONLY', status: 'ACTIVE',
      });
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(own('IDLE'));
      sessionService.saveMessage.mockResolvedValue(message(101, 'USER'));
      sessionService.updatePhase.mockResolvedValue(undefined);
      harnessService.prepareMessage.mockResolvedValue('e-live-1');
      harnessService.executeFromEvent.mockResolvedValue(undefined);
      messageQueueService.listPending.mockResolvedValue([]);

      // busy 入队已登记 queueSettlements（用户会话忙时又入队了一条定时任务消息）
      const queued = (handler as unknown as { queueSettlements: Map<number, { source: string; taskId: number | null; triggerId: number | null }> }).queueSettlements;
      queued.set(16, { source: 'SCHEDULED', taskId: 9, triggerId: null });
      // 用户在提交前窗口点了停止 → pendingCancels 登记；startedAt 取同一时刻使 takePendingCancel 命中
      const stoppedAt = Date.now();
      (handler as unknown as { pendingCancels: Map<number, number> }).pendingCancels.set(16, stoppedAt);

      await handler.executePersistedUserPrompt(
        own('IDLE'), 7, 'e-live-1', { id: 101, content: '定时任务' }, stoppedAt, 4242,
      );
      await executor.runAll();

      expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(16, 7, 'CANCELLED', 'e-live-1');
      // busy 簿记必须被收敛：映射清空 + 回写 CANCELLED，不得永久停在 QUEUED
      expect(queued.has(16)).toBe(false);
      expect(onScheduledTaskQueueConsumed).toHaveBeenCalledWith(9, 'CANCELLED');
      // 收件箱来源簿记同样按归属清理，不残留到后续手工执行
      const live = (handler as unknown as { liveSourceBindings: Map<number, { source: string }> }).liveSourceBindings;
      expect(live.has(16)).toBe(false);
      vi.useRealTimers();
    });

    it('insert_message compensates when a failure lands after the queue row was deleted', async () => {
      // 插队：saveMessage 落库 → delete 队列行 → sendQueueUpdated 抛 DB 异常 →
      // 必须删孤儿 USER 消息 + 回补队首（透传 scheduledTaskId），失败可观测不再静默。
      vi.clearAllMocks();
      executor.tasks.length = 0;
      registry.getUserId.mockReturnValue(7);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'COMPLETED'));
      sessionService.saveMessage.mockResolvedValue(message(77, 'USER'));
      sessionService.deleteMessageById.mockResolvedValue(undefined);
      messageQueueService.getById.mockResolvedValue({ id: 5, sessionId: 11, status: 'PENDING', content: 'insert-me', images: null, scheduledTaskId: 9 });
      messageQueueService.delete.mockResolvedValue(undefined);
      messageQueueService.enqueueHead.mockResolvedValue(undefined);
      // 第一次 listPending（删行后的 sendQueueUpdated）抛 DB 异常，补偿内重试恢复
      messageQueueService.listPending.mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);

      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'insert_message', sessionId: 11, data: { queueId: 5 },
      }));
      await executor.runAll();

      expect(sessionService.deleteMessageById).toHaveBeenCalledWith(11, 77);
      expect(messageQueueService.enqueueHead).toHaveBeenCalledWith(11, 7, 'insert-me', null, 9, 'SCHEDULED', null);
      expect(handler.hasExecutionClaim(11)).toBe(false);
    });

    it('cancel_side_task releases the claim for the side session', async () => {
      await startStuckExecution('IDLE', 'e-2');

      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel_side_task', sideSessionId: 11 }));

      expect(handler.hasExecutionClaim(11)).toBe(false);
    });

    it('retry self-heals a claim left behind by a cancelled execution', async () => {
      await startStuckExecution('IDLE', 'e-3');

      // 用户取消：DB 落终态，但执行体挂起走不到 finally，claim 残留。
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
      expect(handler.hasExecutionClaim(11)).toBe(false);

      // 手动把 claim 放回内存，模拟「取消路径尚未回收」的存量脏数据（线上 2026 即此态）。
      // 直接用公开行为触发一次发送会自带 claim，故这里改为复现用户点击「继续」的路径：
      // 取消已把取消标志置位，自愈逻辑应据此判定陈旧并放行重试。
      harnessService.executeFromEvent.mockResolvedValue(undefined);
      messageQueueService.listPending.mockResolvedValue([]);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'CANCELLED'));

      await handler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));
      await executor.runAll();

      expect(harnessService.executeFromEvent).toHaveBeenCalled();
      expect(sessionService.updatePhase).toHaveBeenCalledWith(11, 'RESUMING');
    });

    it('retry still refuses while a live execution is in flight', async () => {
      // 执行中、无取消标志：真正的在途执行。DB phase 已终态（重试入口要求）但执行仍在跑，
      // 必须拒绝，不能让用户重试出一个并发执行。
      await startStuckExecution('IDLE', 'e-4');
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'CANCELLED'));

      await handler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));

      expect(registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
        type: 'session_already_running', sessionId: 11,
        data: expect.objectContaining({ code: 'session_already_running', executionId: 'e-4' }),
      }));
      expect(harnessService.executeFromEvent).not.toHaveBeenCalled();

      // 收尾：拒绝不应留下在途执行，否则污染后续用例。
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));
      expect(handler.hasExecutionClaim(11)).toBe(false);
    });

    it('send self-heals a claim left behind by a cancelled execution', async () => {
      await startStuckExecution('IDLE', 'e-5');

      // 取消后 DB 已是终态；取消标志已置位，下一次发送应被自愈放行而非拒绝。
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'RUNNING'));
      await handler.handleTextMessage(ws, JSON.stringify({ type: 'cancel', sessionId: 11 }));

      harnessService.executeFromEvent.mockResolvedValue(undefined);
      messageQueueService.listPending.mockResolvedValue([]);
      sessionService.getSession.mockResolvedValue(session('CLOUD', 'CANCELLED'));

      await handler.handleTextMessage(ws, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'again', eventId: 'e-6' },
      }));
      await executor.runAll();

      expect(registry.send).not.toHaveBeenCalledWith(7, expect.objectContaining({
        type: 'session_already_running', sessionId: 11,
      }));
      expect(sessionService.saveMessage).toHaveBeenCalled();
      expect(sessionService.updatePhase).toHaveBeenCalledWith(11, 'RUNNING');
    });
  });
});
