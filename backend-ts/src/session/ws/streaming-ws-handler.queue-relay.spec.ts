import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from './streaming-ws-handler.js';
import type { Session } from '../../domain/types.js';

/**
 * 跨通道队列接力专项（0.0.434）：
 * - message_queue 排空且会话空闲 → 接力消费 IM 入站队列（飞书/钉钉）；
 * - 跨通道忙检查（IM busy / DB phase）→ 有 IM 执行在跑时不消费，等其收尾接力；
 * - 函数级重入保护：并发触发只放一个进入。
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

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, sessionId: 11, userId: 7, content: '系统提示：定时任务触发', images: null,
    sortOrder: 1, status: 'PENDING', scheduledTaskId: 21, sourceType: 'SCHEDULED',
    openTriggerId: null, openCallLogId: null, createdAt: '2026-11-05 09:00:00', ...overrides,
  };
}

function makeHarness() {
  const executor = new CapturingExecutor();
  const registry = {
    send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), hasLocalClientConnection: vi.fn(() => false),
    sendToLocalClients: vi.fn(), sendToDevice: vi.fn(() => ({ targetCount: 0, successCount: 0, failureCount: 0 })), hasDeviceConnection: vi.fn(() => false), getDeviceExecutorSocket: vi.fn(() => null), getDeviceId: vi.fn(() => null), getDeviceInfo: vi.fn(() => null), getDevice: vi.fn(() => null), getOnlineDeviceIds: vi.fn(() => []), clearActiveToolCalls: vi.fn(), setSessionThinking: vi.fn(),
    getSessionExecution: vi.fn(() => undefined),
    // WS 入口（handleTextMessage）鉴权与用户解析
    getUserId: vi.fn(() => 7), isConnectionAuthorized: vi.fn(() => true), closeConnection: vi.fn(),
    getEmbedSessionsForConnection: vi.fn(() => []),
  };
  const sessionService = {
    getSession: vi.fn(async () => ({ id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'COMPLETED', permissionLevel: 'READ_ONLY', status: 'ACTIVE' }) as Session),
    saveMessage: vi.fn(async () => ({ id: 201, sessionId: 11, role: 'USER', content: 'x' })),
    updatePhase: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    deleteMessageById: vi.fn(async () => undefined),
    cleanupIncompleteTail: vi.fn(async () => 0),
  };
  const messageQueueService = {
    listPending: vi.fn(async () => []), enqueue: vi.fn(async () => undefined), dequeue: vi.fn(async () => null),
    getById: vi.fn(async () => null), delete: vi.fn(async () => undefined), enqueueHead: vi.fn(async () => undefined),
  };
  const handler = new StreamingWsHandler({
    registry,
    titleService: { scheduleForFirstUserMessage: vi.fn() },
    harnessService: { prepareMessage: vi.fn(), executeFromEvent: vi.fn(async () => undefined), executePrepared: vi.fn() },
    sessionService,
    taskTerminalService: { finishExecution: vi.fn(async () => undefined) },
    messageQueueService,
    localToolSessionRegistry: {
      setTargetForSession: vi.fn(), resolveTarget: vi.fn(async () => null), isConnected: vi.fn(async () => true), failAllForSession: vi.fn(), failAllForUser: vi.fn(), failAllForDevice: vi.fn(), failAllForSocket: vi.fn(),
      completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
    },
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
    mcpSyncService: { loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})), clearSession: vi.fn(), clearLocalSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn() },
    mcpClientManager: { closeSession: vi.fn() },
    agentMapper: { selectById: vi.fn(async () => ({ id: 5, name: 'A' })) },
    llmModelMapper: { selectById: vi.fn(), selectDefault: vi.fn() },
    jwtService: {} as never,
    agentExecutor: (fn: () => void | Promise<void>) => executor.submit(fn),
    mcpSyncTimeoutSeconds: 60,
  } as unknown as WsHandlerDeps);
  return { handler, executor, registry, sessionService, messageQueueService };
}

describe('StreamingWsHandler 跨通道队列接力（0.0.434）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('message_queue 排空且会话空闲时，接力消费 IM 入站队列（默认开启）', async () => {
    const h = makeHarness();
    const imDrain = vi.fn();
    h.handler.registerImQueueDrainHandler(imDrain);
    h.handler.registerImQueueDrainHandler(() => { throw new Error('单个接力出口异常不应影响其它出口'); });
    await h.handler.autoConsumeQueue(11, 7);
    expect(imDrain).toHaveBeenCalledWith(11);
  });

  it('relayToIm=false 时不再向 IM 侧回传（避免两条链互相传递）', async () => {
    const h = makeHarness();
    const imDrain = vi.fn();
    h.handler.registerImQueueDrainHandler(imDrain);
    await h.handler.autoConsumeQueue(11, 7, { relayToIm: false });
    expect(imDrain).not.toHaveBeenCalled();
  });

  it('IM 侧执行占用（externalBusy）时不消费、不接力', async () => {
    const h = makeHarness();
    const imDrain = vi.fn();
    h.handler.registerImQueueDrainHandler(imDrain);
    h.handler.registerExternalBusyCheck(() => true);
    h.handler.registerExternalBusyCheck(() => { throw new Error('单个检查异常不应影响判定'); });
    h.messageQueueService.listPending.mockResolvedValue([pendingRow()]);
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.messageQueueService.dequeue).not.toHaveBeenCalled();
    expect(imDrain).not.toHaveBeenCalled();
  });

  it('DB phase 活跃（RUNNING）时不消费（等执行收尾接力）', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockResolvedValue({ id: 11, userId: 7, phase: 'RUNNING' } as Session);
    h.messageQueueService.listPending.mockResolvedValue([pendingRow()]);
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.messageQueueService.dequeue).not.toHaveBeenCalled();
  });

  it('phase=FAILED 时不消费（失败不自动消费下一条的兜底门禁）', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockResolvedValue({ id: 11, userId: 7, phase: 'FAILED' } as Session);
    h.messageQueueService.listPending.mockResolvedValue([pendingRow()]);
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.messageQueueService.dequeue).not.toHaveBeenCalled();
  });

  it('phase 查询失败时保守跳过（等下一次执行收尾接力）', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockRejectedValue(new Error('db down'));
    h.messageQueueService.listPending.mockResolvedValue([pendingRow()]);
    await h.handler.autoConsumeQueue(11, 7);
    expect(h.messageQueueService.dequeue).not.toHaveBeenCalled();
  });

  it('IM 通道占用会话时手动发送被拒绝（跨通道忙复检）', async () => {
    const h = makeHarness();
    h.handler.registerExternalBusyCheck(() => true);
    const ws = { id: 'ws-1', readyState: 1, send: vi.fn(), close: vi.fn() } as never;
    await h.handler.handleTextMessage(
      ws,
      JSON.stringify({ type: 'send_message', sessionId: 11, data: { content: 'hi' } }),
    );
    expect(h.registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_already_running',
      data: expect.objectContaining({ code: 'session_already_running' }),
    }));
    // 拒绝必须发生在落库/占位之前
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
  });

  it('并发触发时只放一个进入，当前轮结束后补跑被吞的调用（不丢弃）', async () => {
    const h = makeHarness();
    let call = 0;
    let resolveList!: (rows: unknown[]) => void;
    h.messageQueueService.listPending.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise<unknown[]>((resolve) => { resolveList = resolve; });
      return Promise.resolve([]);
    });
    const first = h.handler.autoConsumeQueue(11, 7, { relayToIm: false });
    const second = h.handler.autoConsumeQueue(11, 7, { relayToIm: false });
    resolveList([]);
    await first;
    await second;
    // 第一轮（并发只进一次）+ 被吞调用的补跑轮 = 2 次扫描
    expect(h.messageQueueService.listPending).toHaveBeenCalledTimes(2);
  });

  it('忙路径等待队列推送期间到达的调用：当前轮结束后必须补跑一轮', async () => {
    const h = makeHarness();
    let call = 0;
    let releasePush!: (rows: unknown[]) => void;
    h.messageQueueService.listPending.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve([pendingRow()]);
      if (call === 2) return new Promise<unknown[]>((resolve) => { releasePush = resolve; });
      return Promise.resolve([pendingRow()]);
    });
    // 恒忙：模拟 IM 执行仍在跑（第一次判定用的「忙快照」在等待推送期间过期）
    h.handler.registerExternalBusyCheck(() => true);
    const first = h.handler.autoConsumeQueue(11, 7);
    await vi.waitFor(() => expect(call).toBe(2));
    const second = h.handler.autoConsumeQueue(11, 7); // 模拟 IM 收尾 relay：被重入保护吞掉
    releasePush([]);
    await first;
    await second;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 补跑轮应再次扫描队列（call=3 为补跑扫描）
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it('dequeue 为空（队头在查询间被移除）时按空队列处理并接力 IM', async () => {
    const h = makeHarness();
    const imDrain = vi.fn();
    h.handler.registerImQueueDrainHandler(imDrain);
    h.messageQueueService.listPending.mockResolvedValue([pendingRow()]);
    h.messageQueueService.dequeue.mockResolvedValue(null);
    await h.handler.autoConsumeQueue(11, 7);
    expect(imDrain).toHaveBeenCalledWith(11);
  });

  it('补跑沿用被吞调用的 relay 意图：relayToIm=false 不在补跑轮向 IM 回传', async () => {
    const h = makeHarness();
    const imDrain = vi.fn();
    h.handler.registerImQueueDrainHandler(imDrain);
    let call = 0;
    let resolveList!: (rows: unknown[]) => void;
    h.messageQueueService.listPending.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise<unknown[]>((resolve) => { resolveList = resolve; });
      return Promise.resolve([]);
    });
    const first = h.handler.autoConsumeQueue(11, 7, { relayToIm: false });
    const second = h.handler.autoConsumeQueue(11, 7, { relayToIm: false });
    resolveList([]);
    await first;
    await second;
    expect(call).toBe(2);
    expect(imDrain).not.toHaveBeenCalled();
  });

  it('补跑沿用被吞调用的 relay 意图：默认 relay=true 时补跑轮恢复向 IM 回传', async () => {
    const h = makeHarness();
    const imDrain = vi.fn();
    h.handler.registerImQueueDrainHandler(imDrain);
    let call = 0;
    let resolveList!: (rows: unknown[]) => void;
    h.messageQueueService.listPending.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise<unknown[]>((resolve) => { resolveList = resolve; });
      return Promise.resolve([]);
    });
    const first = h.handler.autoConsumeQueue(11, 7);
    const second = h.handler.autoConsumeQueue(11, 7);
    resolveList([]);
    await first;
    await second;
    expect(call).toBe(2);
    expect(imDrain).toHaveBeenCalledWith(11);
  });
});
