import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from './streaming-ws-handler.js';
import type { Message, Session } from '../../domain/types.js';
import type { WsSocket } from './streaming-ws-registry.js';

/**
 * 开放接口 source 透传专项（技术方案 §5.6）：
 * - liveExecution 路径：executePersistedUserPrompt 第 7 参 source → finishExecution；
 * - 队列路径：行 source_type/open_trigger_id → settlement → 收件箱来源 + 触发器回写；
 * - 回补队首保源：补偿 enqueueHead 透传 (scheduledTaskId, source, openTriggerId) 三元组。
 */

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

function makeHarness() {
  const executor = new CapturingExecutor();
  const registry = {
    isConnectionAuthorized: vi.fn(() => true), sendToConnection: vi.fn(),
    closeConnection: vi.fn(), getUserId: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    register: vi.fn(), unregister: vi.fn(), hasLocalClientConnection: vi.fn(),
    sendToLocalClients: vi.fn(), getActiveToolCalls: vi.fn(() => []), clearActiveToolCalls: vi.fn(),
    isSessionThinking: vi.fn(() => false), setSessionThinking: vi.fn(),
    getClientType: vi.fn(() => 'browser'), bindEmbedSession: vi.fn(), unbindEmbedSession: vi.fn(),
    getEmbedSessionsForConnection: vi.fn(() => []), getEmbedSessionConnection: vi.fn(() => null),
    getEmbedSessionBinding: vi.fn(() => null),
  };
  const titleService = { scheduleForFirstUserMessage: vi.fn() };
  const harnessService = { prepareMessage: vi.fn(), executeFromEvent: vi.fn(async () => undefined), executePrepared: vi.fn(), executeSideFirstMessage: vi.fn(), forkParentMessages: vi.fn() };
  const sessionService = {
    getSession: vi.fn(async () => ({ id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'COMPLETED', permissionLevel: 'READ_ONLY', status: 'ACTIVE' }) as Session),
    saveMessage: vi.fn(async () => ({ id: 201, sessionId: 11, role: 'USER', content: 'x' }) as Message),
    updatePhase: vi.fn(async () => undefined), updateField: vi.fn(), updateModelId: vi.fn(),
    getMessages: vi.fn(async () => []), editMessageAndTruncate: vi.fn(), save: vi.fn(),
    findOwnedMessage: vi.fn(async () => null), listSubagentSessions: vi.fn(async () => []),
    cleanupIncompleteTail: vi.fn(async () => 0), updateContextTokens: vi.fn(),
    getLastUserMessage: vi.fn(async () => null), deleteMessageById: vi.fn(async () => undefined),
  };
  const taskTerminalService = { finishExecution: vi.fn(async () => undefined) };
  const onScheduledTaskQueueConsumed = vi.fn(async () => undefined);
  const onOpenTriggerQueueConsumed = vi.fn(async () => undefined);
  const messageQueueService = {
    listPending: vi.fn(async () => []), enqueue: vi.fn(async () => undefined), dequeue: vi.fn(async () => null),
    getById: vi.fn(async () => null), delete: vi.fn(async () => undefined), moveToIndex: vi.fn(async () => undefined),
    enqueueHead: vi.fn(async () => undefined),
  };
  const localToolSessionRegistry = {
    setUserForSession: vi.fn(), isConnected: vi.fn(async () => true), failAllForSession: vi.fn(), failAllForUser: vi.fn(),
    completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
  };
  const handler = new StreamingWsHandler({
    registry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
    onScheduledTaskQueueConsumed, onOpenTriggerQueueConsumed,
    localToolSessionRegistry,
    askUserQuestionsRegistry: { failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []), complete: vi.fn() },
    embedPageToolRegistry: { request: vi.fn(), complete: vi.fn(), failSession: vi.fn(), isEmbedSession: vi.fn(() => false), hasBoundConnection: vi.fn(() => false), pendingCount: vi.fn(() => 0) },
    treeSignalPublisher: { publishIfSideTask: vi.fn(), publishForSession: vi.fn() },
    approvalRegistry: { unregister: vi.fn() },
    activityService: { record: vi.fn() },
    activityHeartbeat: { touch: vi.fn(), clear: vi.fn() },
    sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
    agentLoop: { registerCancelFlag: vi.fn(() => ({ get: () => false, set: () => undefined })), removeCancelFlag: vi.fn(), requestCancel: vi.fn() },
    shellSessionManager: { closeByConversation: vi.fn() },
    skillSyncService: { syncToSession: vi.fn(), getRemovedSkillNames: vi.fn(() => []) },
    localSkillRegistry: { report: vi.fn(), clear: vi.fn() },
    localAgentsMdRegistry: { report: vi.fn(), clear: vi.fn() },
    mcpSyncService: { loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})), clearSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn() },
    mcpClientManager: { closeSession: vi.fn() },
    agentMapper: { selectById: vi.fn(async () => ({ id: 5, name: 'A' })) },
    llmModelMapper: { selectById: vi.fn(), selectDefault: vi.fn() },
    jwtService: {} as never,
    agentExecutor: (fn: () => void | Promise<void>) => executor.submit(fn),
    mcpSyncTimeoutSeconds: 60,
  } as unknown as WsHandlerDeps);

  const ws: WsSocket = { id: 'ws-src', readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as WsSocket;
  return { handler, executor, registry, sessionService, taskTerminalService, messageQueueService, harnessService, onScheduledTaskQueueConsumed, onOpenTriggerQueueConsumed, titleService, ws };
}

describe('StreamingWsHandler source 透传（开放接口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executePersistedUserPrompt 第 7 参 source：API 直跑 → finishExecution 带 API', async () => {
    const h = makeHarness();
    h.registry.getUserId.mockReturnValue(7);
    const session = { id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'IDLE', permissionLevel: 'READ_ONLY', status: 'ACTIVE' } as Session;
    await h.handler.executePersistedUserPrompt(session, 7, 'exec-open-1', { id: 300, sessionId: 11, role: 'USER', content: 'go' } as Message, Date.now(), null, 'API');
    await h.executor.runAll();
    expect(h.taskTerminalService.finishExecution).toHaveBeenCalledWith(11, 7, 'COMPLETED', 'exec-open-1', undefined, 'API');
  });

  it('队列行 source_type=WEBHOOK + open_trigger_id：终态后触发器回写 + 收件箱来源 WEBHOOK', async () => {
    const h = makeHarness();
    h.registry.getUserId.mockReturnValue(7);
    let pending1 = [{ id: 1, sessionId: 11, userId: 7, content: 'hook event', images: null, sourceType: 'WEBHOOK', openTriggerId: 3, scheduledTaskId: null }];
    h.messageQueueService.listPending.mockImplementation(async () => pending1);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending1[0] ?? null;
      pending1 = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    // 消费经 agentExecutor 的 500ms 延迟窗口
    await new Promise((r) => setTimeout(r, 560));
    await h.executor.runAll();
    expect(h.onOpenTriggerQueueConsumed).toHaveBeenCalledWith(3, 'COMPLETED');
    expect(h.onScheduledTaskQueueConsumed).not.toHaveBeenCalled();
    expect(h.taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'COMPLETED', expect.any(String), undefined, 'WEBHOOK',
    );
  });

  it('存量行（source_type 为 NULL + scheduledTaskId）：回退 SCHEDULED，走任务回写', async () => {
    const h = makeHarness();
    h.registry.getUserId.mockReturnValue(7);
    let pending2 = [{ id: 2, sessionId: 11, userId: 7, content: 'legacy', images: null, scheduledTaskId: 77 }];
    h.messageQueueService.listPending.mockImplementation(async () => pending2);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending2[0] ?? null;
      pending2 = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    await new Promise((r) => setTimeout(r, 560));
    await h.executor.runAll();
    expect(h.onScheduledTaskQueueConsumed).toHaveBeenCalledWith(77, 'COMPLETED');
    expect(h.onOpenTriggerQueueConsumed).not.toHaveBeenCalled();
    expect(h.taskTerminalService.finishExecution).toHaveBeenCalledWith(
      11, 7, 'COMPLETED', expect.any(String), undefined, 'SCHEDULED',
    );
  });

  it('消费失败补偿：enqueueHead 透传 (null, WEBHOOK, triggerId) 保源回补', async () => {
    const h = makeHarness();
    h.registry.getUserId.mockReturnValue(7);
    let pending3 = [{ id: 3, sessionId: 11, userId: 7, content: 'hook retry', images: null, sourceType: 'WEBHOOK', openTriggerId: 9, scheduledTaskId: null }];
    h.messageQueueService.listPending.mockImplementation(async () => pending3);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending3[0] ?? null;
      pending3 = [];
      return head;
    });
    h.sessionService.saveMessage.mockRejectedValue(new Error('db down'));
    await h.handler.autoConsumeQueue(11, 7);
    await new Promise((r) => setTimeout(r, 560));
    await h.executor.runAll();
    expect(h.messageQueueService.enqueueHead).toHaveBeenCalledWith(11, 7, 'hook retry', null, null, 'WEBHOOK', 9, null);
    expect(h.onOpenTriggerQueueConsumed).not.toHaveBeenCalled();
  });
});
