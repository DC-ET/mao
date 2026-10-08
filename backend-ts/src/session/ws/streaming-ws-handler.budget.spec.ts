import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, budgetBlockMessage, type BudgetBlockInfo, type WsHandlerDeps } from './streaming-ws-handler.js';
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'IDLE',
    permissionLevel: 'READ_ONLY', status: 'ACTIVE',
    ...overrides,
  } as Session;
}

function message(id: number) {
  return { id, sessionId: 11, role: 'USER', content: 'content' };
}

const BLOCK: BudgetBlockInfo = {
  budgetId: 9, scope: 'GLOBAL', scopeId: null, spend: 12.5, limitValue: 10, limitType: 'COST',
};

interface Harness {
  handler: StreamingWsHandler;
  registry: Record<string, ReturnType<typeof vi.fn>>;
  sessionService: Record<string, ReturnType<typeof vi.fn>>;
  messageQueueService: Record<string, ReturnType<typeof vi.fn>>;
  harnessService: Record<string, ReturnType<typeof vi.fn>>;
  checkAdmission: ReturnType<typeof vi.fn>;
  noticeQueueBlocked: ReturnType<typeof vi.fn>;
  executor: CapturingExecutor;
}

function buildHarness(options: { withBudgetGate?: boolean; checkAdmission?: () => Promise<BudgetBlockInfo | null> } = {}): Harness {
  const executor = new CapturingExecutor();
  const registry = {
    isConnectionAuthorized: vi.fn(() => true), sendToConnection: vi.fn(),
    closeConnection: vi.fn(), getUserId: vi.fn(() => 7), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    register: vi.fn(), unregister: vi.fn(), hasLocalClientConnection: vi.fn(() => true),
    sendToLocalClients: vi.fn(), getActiveToolCalls: vi.fn(() => []), clearActiveToolCalls: vi.fn(),
    isSessionThinking: vi.fn(() => false), setSessionThinking: vi.fn(),
    getClientType: vi.fn(() => 'browser'), bindEmbedSession: vi.fn(), unbindEmbedSession: vi.fn(),
    getEmbedSessionsForConnection: vi.fn(() => []), getEmbedSessionConnection: vi.fn(() => null),
    getEmbedSessionBinding: vi.fn(() => null),
  };
  const sessionService = {
    getSession: vi.fn(async () => session()),
    saveMessage: vi.fn(async () => message(99)),
    updatePhase: vi.fn(async () => undefined),
    updateField: vi.fn(),
    updateModelId: vi.fn(),
    getMessages: vi.fn(async () => [message(3)]),
    editMessageAndTruncate: vi.fn(async () => message(3)),
    save: vi.fn(),
    findOwnedMessage: vi.fn(async () => null),
    listSubagentSessions: vi.fn(async () => []),
    cleanupIncompleteTail: vi.fn(async () => 0), updateContextTokens: vi.fn(),
    getLastUserMessage: vi.fn(async () => message(3)),
    deleteMessageById: vi.fn(async () => undefined),
  };
  const messageQueueService = {
    listPending: vi.fn(async () => []),
    enqueue: vi.fn(),
    dequeue: vi.fn(async () => null),
    getById: vi.fn(),
    delete: vi.fn(),
    moveToIndex: vi.fn(),
    enqueueHead: vi.fn(async () => undefined),
  };
  const harnessService = {
    prepareMessage: vi.fn(async () => 'event-1'),
    executeFromEvent: vi.fn(async () => undefined),
    executePrepared: vi.fn(),
    executeSideFirstMessage: vi.fn(),
    forkParentMessages: vi.fn(),
  };
  const checkAdmission = vi.fn(options.checkAdmission ?? (async () => null));
  const noticeQueueBlocked = vi.fn(async () => undefined);
  const handler = new StreamingWsHandler({
    registry, titleService: { scheduleForFirstUserMessage: vi.fn() }, harnessService,
    sessionService, taskTerminalService: { finishExecution: vi.fn() }, messageQueueService,
    onScheduledTaskQueueConsumed: vi.fn(async () => undefined),
    localToolSessionRegistry: {
      setUserForSession: vi.fn(), isConnected: vi.fn(() => true), failAllForSession: vi.fn(), failAllForUser: vi.fn(),
      completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
    },
    askUserQuestionsRegistry: { failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []), complete: vi.fn() },
    embedPageToolRegistry: {
      request: vi.fn(), complete: vi.fn(() => true), failSession: vi.fn(), isEmbedSession: vi.fn(() => false),
      hasBoundConnection: vi.fn(() => false), pendingCount: vi.fn(() => 0),
    },
    treeSignalPublisher: { publishIfSideTask: vi.fn(), publishForSession: vi.fn() },
    approvalRegistry: { unregister: vi.fn() },
    activityService: { record: vi.fn() },
    activityHeartbeat: { touch: vi.fn(), clear: vi.fn() },
    sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
    agentLoop: {
      registerCancelFlag: vi.fn(() => { let v = false; return { get: () => v, set: (n: boolean) => { v = n; } }; }),
      removeCancelFlag: vi.fn(), requestCancel: vi.fn(),
    },
    shellSessionManager: { closeByConversation: vi.fn() },
    skillSyncService: { syncToSession: vi.fn(), getRemovedSkillNames: vi.fn(() => []) },
    localSkillRegistry: { report: vi.fn(), clear: vi.fn() },
    localAgentsMdRegistry: { report: vi.fn(), clear: vi.fn() },
    mcpSyncService: {
      loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})),
      clearSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn(),
    },
    mcpClientManager: { closeSession: vi.fn() },
    agentMapper: { selectById: vi.fn(async () => ({ id: 5, name: 'Coder' })) },
    llmModelMapper: { selectById: vi.fn(), selectDefault: vi.fn() },
    jwtService: {},
    agentExecutor: (fn) => executor.submit(fn),
    mcpSyncTimeoutSeconds: 60,
    ...(options.withBudgetGate === false ? {} : { budgetGate: { checkAdmission, noticeQueueBlocked } }),
  } as unknown as WsHandlerDeps);
  return { handler, registry, sessionService, messageQueueService, harnessService, checkAdmission, noticeQueueBlocked, executor };
}

const ws: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };

function errorEvents(registry: Record<string, ReturnType<typeof vi.fn>>): WsEvent[] {
  return vi.mocked(registry.send).mock.calls
    .map((c) => c[1] as WsEvent)
    .filter((e) => e.type === 'error');
}

describe('StreamingWsHandler 预算 BLOCK 闸门（§5.7）', () => {
  it('budgetBlockMessage 携带 scope / 当期消耗 / 上限 / 口径', () => {
    expect(budgetBlockMessage(BLOCK)).toBe('本月全局预算已超限：当期消耗 12.5 / 上限 10（成本 口径），新任务已被拒绝。请调整预算或联系管理员');
    expect(budgetBlockMessage({ ...BLOCK, scope: 'USER', limitType: 'TOKENS' })).toContain('本月用户预算已超限');
    expect(budgetBlockMessage({ ...BLOCK, scope: 'AGENT' })).toContain('本月Agent预算已超限');
  });

  it('手动发送 BLOCK：显式 error 事件、消息不落库、不提交执行、占位释放（会话可重试）', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hello', eventId: 'e-1' } }));
    expect(h.checkAdmission).toHaveBeenCalledWith({ userId: 7, agentId: 5 });
    const errors = errorEvents(h.registry);
    expect(errors).toHaveLength(1);
    expect(errors[0].sessionId).toBe(11);
    expect((errors[0].data as { message: string }).message).toContain('本月全局预算已超限');
    // 未落库、未执行、未订阅——BLOCK 后重试不会撞 session_already_running
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
    expect(h.harnessService.executeFromEvent).not.toHaveBeenCalled();
    expect(h.registry.subscribe).not.toHaveBeenCalled();
    expect(h.handler.hasExecutionClaim(11)).toBe(false);
  });

  it('预算恢复后同一会话可再次发送（占位已释放）', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'blocked' } }));
    h.checkAdmission.mockResolvedValue(null);
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'retry', eventId: 'e-2' } }));
    expect(h.sessionService.saveMessage).toHaveBeenCalledTimes(1);
    expect(h.registry.send).not.toHaveBeenCalledWith(7, expect.objectContaining({ type: 'session_already_running' }));
    await h.executor.runAll();
  });

  it('未注入 budgetGate（budget 域未装配）→ 不检查、正常放行', async () => {
    const h = buildHarness({ withBudgetGate: false });
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hello', eventId: 'e-1' } }));
    expect(h.sessionService.saveMessage).toHaveBeenCalled();
    expect(errorEvents(h.registry)).toHaveLength(0);
    await h.executor.runAll();
  });

  it('子代理 / 边路会话不单独检查（跟随父会话准入结论）', async () => {
    for (const sessionType of ['SUBAGENT', 'SIDE_TASK']) {
      const h = buildHarness({ checkAdmission: async () => BLOCK });
      h.sessionService.getSession.mockResolvedValue(session({ sessionType, parentSessionId: 3 }));
      await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'child work', eventId: 'e-1' } }));
      expect(h.checkAdmission, sessionType).not.toHaveBeenCalled();
      expect(errorEvents(h.registry), sessionType).toHaveLength(0);
      await h.executor.runAll();
    }
  });

  it('编辑重发 BLOCK：原消息不被截断、占位释放、显式 error', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'edit_and_resend', sessionId: 11, messageId: 3, content: 'edited' }));
    expect(h.checkAdmission).toHaveBeenCalledWith({ userId: 7, agentId: 5 });
    expect(h.sessionService.editMessageAndTruncate).not.toHaveBeenCalled();
    expect(h.harnessService.prepareMessage).not.toHaveBeenCalled();
    expect(h.handler.hasExecutionClaim(11)).toBe(false);
    const errors = errorEvents(h.registry);
    expect(errors).toHaveLength(1);
    expect((errors[0].data as { message: string }).message).toContain('本月全局预算已超限');
  });

  it('编辑重发 BLOCK 后同一会话可再次编辑（占位未残留）', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'edit_and_resend', sessionId: 11, messageId: 3, content: 'edited' }));
    h.checkAdmission.mockResolvedValue(null);
    await h.handler.handleTextMessage(ws, JSON.stringify({ type: 'edit_and_resend', sessionId: 11, messageId: 3, content: 'edited2' }));
    expect(h.sessionService.editMessageAndTruncate).toHaveBeenCalledTimes(1);
    expect(h.registry.send).not.toHaveBeenCalledWith(7, expect.objectContaining({ type: 'session_already_running' }));
    await h.executor.runAll();
  });

  it('队列消费 BLOCK：消息回补队首（留队）+ 一次收件箱提醒 + 显式 error，消息不落库', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null };
    let pending = [queued];
    h.messageQueueService.listPending.mockImplementation(async () => pending);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    // 检查点位于 dequeue 之后：会话仍按主会话归属查询
    expect(h.checkAdmission).toHaveBeenCalledWith({ userId: 7, agentId: 5 });
    expect(h.noticeQueueBlocked).toHaveBeenCalledTimes(1);
    expect(h.noticeQueueBlocked).toHaveBeenCalledWith(BLOCK, 7);
    // 补偿链路：回补队首 + 推 queue_updated（无孤儿消息需删）
    expect(h.messageQueueService.enqueueHead).toHaveBeenCalledWith(11, 7, '#{next}#', null, null, null, null);
    expect(h.sessionService.deleteMessageById).not.toHaveBeenCalled();
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
    const errors = errorEvents(h.registry);
    expect(errors).toHaveLength(1);
    expect((errors[0].data as { message: string }).message).toContain('本月全局预算已超限');
    // 占位已释放：队列后续仍可被消费（不会永久卡在 claimed 状态）
    expect(h.handler.hasExecutionClaim(11)).toBe(false);
  });

  it('队列消费 BLOCK：带来源行（定时任务）原样保源回补队首', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null, sourceType: 'SCHEDULED', scheduledTaskId: 55 };
    let pending = [queued];
    h.messageQueueService.listPending.mockImplementation(async () => pending);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.messageQueueService.enqueueHead).toHaveBeenCalledWith(11, 7, '#{next}#', null, 55, 'SCHEDULED', null);
    expect(h.noticeQueueBlocked).toHaveBeenCalledWith(BLOCK, 7);
  });

  it('队列消费 BLOCK：连续两次越线各提醒一次（收件箱按 budgetId+周期去重）', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null };
    for (let round = 0; round < 2; round++) {
      let pending = [queued];
      h.messageQueueService.listPending.mockImplementation(async () => pending);
      h.messageQueueService.dequeue.mockImplementation(async () => {
        const head = pending[0] ?? null;
        pending = [];
        return head;
      });
      await h.handler.autoConsumeQueue(11, 7);
      expect(h.messageQueueService.enqueueHead).toHaveBeenCalledTimes(round + 1);
    }
    // 处理器侧每次留队都调用提醒入口，幂等由 InboxService 的 dedup key 保证
    expect(h.noticeQueueBlocked).toHaveBeenCalledTimes(2);
    expect(h.handler.hasExecutionClaim(11)).toBe(false);
  });

  it('队列消费未命中 → 正常落库执行，不回补不提醒', async () => {
    const h = buildHarness();
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null };
    let pending = [queued];
    h.messageQueueService.listPending.mockImplementation(async () => pending);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.messageQueueService.enqueueHead).not.toHaveBeenCalled();
    expect(h.noticeQueueBlocked).not.toHaveBeenCalled();
    expect(h.sessionService.saveMessage).toHaveBeenCalledWith(11, 'USER', '#{next}#', null, null, null, 0, null);
    await h.executor.runAll();
  });

  it('队列消费未命中时子代理会话同样跳过检查', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    h.sessionService.getSession.mockResolvedValue(session({ sessionType: 'SUBAGENT', parentSessionId: 3 }));
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null };
    let pending = [queued];
    h.messageQueueService.listPending.mockImplementation(async () => pending);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.checkAdmission).not.toHaveBeenCalled();
    expect(h.messageQueueService.enqueueHead).not.toHaveBeenCalled();
    expect(h.sessionService.saveMessage).toHaveBeenCalled();
    await h.executor.runAll();
  });

  it('registry 发送失败不阻塞 BLOCK 语义（error 事件尽力而为）', async () => {
    const h = buildHarness({ checkAdmission: async () => BLOCK });
    h.registry.send.mockImplementationOnce(() => { throw new Error('socket gone'); });
    await expect(h.handler.handleTextMessage(ws, JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hello' } })))
      .resolves.toBeUndefined();
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
    expect(h.handler.hasExecutionClaim(11)).toBe(false);
  });
});

describe('StreamingWsHandler budgetGate 未注入', () => {
  it('无 gate 时队列消费链路照常', async () => {
    const h = buildHarness({ withBudgetGate: false });
    const queued = { id: 8, sessionId: 11, userId: 7, content: '#{next}#', sortOrder: 1, images: null };
    let pending = [queued];
    h.messageQueueService.listPending.mockImplementation(async () => pending);
    h.messageQueueService.dequeue.mockImplementation(async () => {
      const head = pending[0] ?? null;
      pending = [];
      return head;
    });
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.sessionService.saveMessage).toHaveBeenCalled();
    expect(h.messageQueueService.enqueueHead).not.toHaveBeenCalled();
    await h.executor.runAll();
  });
});
