import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from './streaming-ws-handler.js';
import type { WsEvent } from './ws-event.js';
import type { Session } from '../../domain/types.js';
import type { WsSocket } from './streaming-ws-registry.js';
import { WS_OPEN } from './streaming-ws-registry.js';

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
    getUserId: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    register: vi.fn(), unregister: vi.fn(), hasLocalClientConnection: vi.fn(),
    sendToLocalClients: vi.fn(), getActiveToolCalls: vi.fn(() => []), clearActiveToolCalls: vi.fn(),
  };
  const titleService = { scheduleForFirstUserMessage: vi.fn() };
  const harnessService = { prepareMessage: vi.fn(), executeFromEvent: vi.fn(), executeSideFirstMessage: vi.fn() };
  const sessionService = {
    getSession: vi.fn(), saveMessage: vi.fn(), updatePhase: vi.fn(), updateField: vi.fn(),
    updateModelId: vi.fn(), getMessages: vi.fn(), editMessageAndTruncate: vi.fn(), save: vi.fn(),
    listSubagentSessions: vi.fn(async () => []),
    cleanupIncompleteTail: vi.fn(async () => 0), updateContextTokens: vi.fn(),
  };
  const taskTerminalService = { finishExecution: vi.fn() };
  const messageQueueService = {
    listPending: vi.fn(async () => []), enqueue: vi.fn(), dequeue: vi.fn(), getById: vi.fn(),
    delete: vi.fn(), reorder: vi.fn(),
  };
  const localToolSessionRegistry = {
    setUserForSession: vi.fn(), isConnected: vi.fn(), failAllForSession: vi.fn(), failAllForUser: vi.fn(),
    completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
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
  const jwtService = { validateToken: vi.fn(), getUserIdFromToken: vi.fn() };
  const ws: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };

  const handler = new StreamingWsHandler({
    registry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
    localToolSessionRegistry, askUserQuestionsRegistry, treeSignalPublisher, approvalRegistry, activityService,
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
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(skillSyncService.syncToSession).toHaveBeenCalled();
    expect(harnessService.executeFromEvent).toHaveBeenCalled();
    expect(sessionService.updatePhase).toHaveBeenCalledWith(11, 'RUNNING');
    expect(taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'event-1');
    expect(activityHeartbeat.clear).toHaveBeenCalledWith(11);
    expect(agentLoop.removeCancelFlag).toHaveBeenCalledWith(11);
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
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'reorder_queue_message', sessionId: 11, data: { queueId: 4, direction: 'up' } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_result', sessionId: 11, requestId: 'req', result: 'ok' }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_error', sessionId: 11, requestId: 'req', error: 'bad' }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'tool_approval', sessionId: 11, requestId: 'req', approved: true }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'ask_user_questions_result', sessionId: 11, data: { requestId: 'q', answers: [{ id: 'a' }] } }));
    await handler.handleTextMessage(ws, JSON.stringify({ type: 'ping' }));
    expect(registry.subscribe).toHaveBeenCalledWith(7, 11);
    expect(registry.unsubscribe).toHaveBeenCalledWith(7, 11);
    expect(messageQueueService.enqueue).toHaveBeenCalledWith(11, 7, 'queued', '["img"]');
    expect(messageQueueService.delete).toHaveBeenCalledWith(4);
    expect(messageQueueService.reorder).toHaveBeenCalledWith(4, 'up');
    expect(localToolSessionRegistry.completeToolRequest).toHaveBeenCalledWith(11, 'req', 'ok');
    expect(localToolSessionRegistry.completeToolRequestError).toHaveBeenCalledWith(11, 'req', 'bad');
    expect(approvalRegistry.unregister).toHaveBeenCalledWith(11, 'req');
    expect(treeSignalPublisher.publishForSession).toHaveBeenCalledWith(11);
    expect(askUserQuestionsRegistry.complete).toHaveBeenCalledWith(11, 'q', '{"answers": [{"id":"a"}]}');
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
      type: 'create_side_session', sessionId: 11, data: { content: 'side work', inheritContext: true, modelId: 9 },
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
      type: 'create_side_session', sessionId: 11, data: { content: 'look', inheritContext: true, images: ['https://cdn.example/a.png'] },
    }));
    expect(sessionService.save).not.toHaveBeenCalled();
    expect(harnessService.executeSideFirstMessage).not.toHaveBeenCalled();
  });

  it('connectionLifecycleUsesTokenAndCleanupHooks', async () => {
    vi.clearAllMocks();
    jwtService.validateToken.mockReturnValue(true);
    jwtService.getUserIdFromToken.mockReturnValue(7);
    registry.getUserId.mockReturnValue(7);
    registry.hasLocalClientConnection.mockReturnValue(false);
    const connected: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    await handler.afterConnectionEstablished(connected, { token: 'valid.jwt.token', client: 'electron' });
    handler.afterConnectionClosed(connected);
    handler.handleTransportError(connected);
    expect(registry.register).toHaveBeenCalledWith(connected, 7, 'electron');
    expect(localToolSessionRegistry.failAllForUser).toHaveBeenCalledTimes(2);
    expect(askUserQuestionsRegistry.failAllForSession).not.toHaveBeenCalled();
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
    jwtService.validateToken.mockReturnValue(false);
    const connected: WsSocket = { id: 'ws-x', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    await handler.afterConnectionEstablished(connected, { token: 'forged', client: 'browser' });
    expect(connected.close).toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
    expect(jwtService.getUserIdFromToken).not.toHaveBeenCalled();
  });

  it('keeps client=cli instead of silently mapping to browser', async () => {
    vi.clearAllMocks();
    jwtService.validateToken.mockReturnValue(true);
    jwtService.getUserIdFromToken.mockReturnValue(7);
    await handler.afterConnectionEstablished(ws, { token: 'ok', client: 'cli' });
    expect(registry.register).toHaveBeenCalledWith(ws, 7, 'cli');
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
});
