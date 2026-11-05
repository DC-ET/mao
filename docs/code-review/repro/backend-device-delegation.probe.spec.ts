import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from '../session/ws/streaming-ws-handler.js';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from '../session/ws/streaming-ws-registry.js';
import { LocalToolSessionRegistry } from '../harness/local/local-tool-session-registry.js';
import type { Session } from '../domain/types.js';

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

const OPEN_META = { userId: 7, expiresAt: Date.now() + 60_000 };

function socket(id: string): WsSocket {
  return { id, readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
}

function session(mode: string, phase: string, extra: Partial<Session> = {}): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: mode, phase,
    permissionLevel: 'READ_ONLY', status: 'ACTIVE', ...extra,
  } as Session;
}

function message(id: number, role: string) {
  return { id, sessionId: 11, role, content: 'content' };
}

function makeHandler(executor = new CapturingExecutor(), overrides: Partial<Record<string, unknown>> = {}) {
  const registry = {
    isConnectionAuthorized: vi.fn(() => true), sendToConnection: vi.fn(),
    closeConnection: vi.fn(), getUserId: vi.fn(() => 7), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    register: vi.fn(), unregister: vi.fn(), hasLocalClientConnection: vi.fn(() => true),
    sendToLocalClients: vi.fn(),
    sendToDevice: vi.fn(() => ({ targetCount: 1, successCount: 1, failureCount: 0 })),
    hasDeviceConnection: vi.fn(() => true), getDeviceId: vi.fn(() => null), getDeviceInfo: vi.fn(() => null),
    getDevice: vi.fn(() => null), getOnlineDeviceIds: vi.fn(() => []), getActiveToolCalls: vi.fn(() => []),
    clearActiveToolCalls: vi.fn(), isSessionThinking: vi.fn(() => false), setSessionThinking: vi.fn(),
    getSessionExecution: vi.fn(() => undefined), setSessionExecution: vi.fn(), clearSessionExecution: vi.fn(),
    getClientType: vi.fn(() => 'browser'), bindEmbedSession: vi.fn(), unbindEmbedSession: vi.fn(),
    getEmbedSessionsForConnection: vi.fn(() => []), getEmbedSessionConnection: vi.fn(() => null),
    getEmbedSessionBinding: vi.fn(() => null),
  };
  const titleService = { scheduleForFirstUserMessage: vi.fn() };
  const harnessService = {
    prepareMessage: vi.fn(async () => 'event-1'), executeFromEvent: vi.fn(), executePrepared: vi.fn(),
    executeSideFirstMessage: vi.fn(), forkParentMessages: vi.fn(), requestCompaction: vi.fn(async () => true),
  };
  const sessionService = {
    getSession: vi.fn(), saveMessage: vi.fn(async () => message(99, 'USER')), updatePhase: vi.fn(), updateField: vi.fn(),
    updateModelId: vi.fn(), getMessages: vi.fn(async () => []), editMessageAndTruncate: vi.fn(),
    save: vi.fn(async (s: Session) => { s.id = 13; }),
    findOwnedMessage: vi.fn(async () => null), listSubagentSessions: vi.fn(async () => []),
    cleanupIncompleteTail: vi.fn(async () => 0), updateContextTokens: vi.fn(),
    getLastUserMessage: vi.fn(async () => message(3, 'USER')), deleteMessageById: vi.fn(async () => undefined),
    claimTargetDevice: vi.fn(async () => null),
  };
  const messageQueueService = {
    listPending: vi.fn(async () => []), enqueue: vi.fn(), dequeue: vi.fn(), getById: vi.fn(),
    delete: vi.fn(), moveToIndex: vi.fn(), enqueueHead: vi.fn(async () => undefined),
  };
  const localToolSessionRegistry = {
    setTargetForSession: vi.fn(), resolveTarget: vi.fn(async () => null), isConnected: vi.fn(async () => true),
    failAllForSession: vi.fn(), failAllForUser: vi.fn(), failAllForDevice: vi.fn(),
    completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
  };
  const deps = {
    registry, titleService, harnessService, sessionService,
    taskTerminalService: { finishExecution: vi.fn() }, messageQueueService,
    onScheduledTaskQueueConsumed: vi.fn(async () => undefined),
    localToolSessionRegistry,
    askUserQuestionsRegistry: { failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []), complete: vi.fn() },
    embedPageToolRegistry: { request: vi.fn(), complete: vi.fn(() => true), failSession: vi.fn(), isEmbedSession: vi.fn(() => false), hasBoundConnection: vi.fn(() => false), pendingCount: vi.fn(() => 0) },
    treeSignalPublisher: { publishIfSideTask: vi.fn(), publishForSession: vi.fn() },
    approvalRegistry: { unregister: vi.fn() },
    activityService: { record: vi.fn() },
    activityHeartbeat: { touch: vi.fn(), clear: vi.fn() },
    sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
    agentLoop: {
      registerCancelFlag: vi.fn(() => { let v = false; return { get: () => v, set: (n: boolean) => { v = n; } }; }),
      removeCancelFlag: vi.fn(), requestCancel: vi.fn(), getCancelFlag: vi.fn(() => undefined),
    },
    shellSessionManager: { closeByConversation: vi.fn() },
    skillSyncService: { syncToSession: vi.fn(), getRemovedSkillNames: vi.fn(() => []) },
    localSkillRegistry: { report: vi.fn(), clear: vi.fn() },
    localAgentsMdRegistry: { report: vi.fn(), clear: vi.fn() },
    mcpSyncService: {
      loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})), clearSession: vi.fn(),
      clearLocalSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn(),
    },
    mcpClientManager: { closeSession: vi.fn() },
    agentMapper: { selectById: vi.fn(async () => ({ id: 5, name: 'Coder' })) },
    llmModelMapper: { selectById: vi.fn(), selectDefault: vi.fn() },
    jwtService: { getAccessTokenMetadata: vi.fn() },
    agentExecutor: (fn: () => void | Promise<void>) => executor.submit(fn),
    mcpSyncTimeoutSeconds: 60,
    compactionSignalBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };
  const handler = new StreamingWsHandler({ ...deps, ...overrides } as unknown as WsHandlerDeps);
  return { handler, deps, executor, registry, localToolSessionRegistry, sessionService, harnessService };
}

describe('probe: device targeted delivery + disconnect cleanup (real registries)', () => {
  it('delivers to bound device only and fails only that device pending requests on close', async () => {
    const wsRegistry = new StreamingWsRegistry(1000);
    try {
      const a = socket('ws-a');
      const b = socket('ws-b');
      wsRegistry.register(a, 7, 'electron', OPEN_META, true, { id: 'dev-a', name: 'A', platform: 'darwin' });
      wsRegistry.register(b, 7, 'electron', OPEN_META, true, { id: 'dev-b', name: 'B', platform: 'darwin' });
      const localRegistry = new LocalToolSessionRegistry(wsRegistry, {
        selectById: vi.fn(async () => null),
      } as never);
      localRegistry.setTargetForSession(11, 7, 'dev-a');
      localRegistry.setTargetForSession(12, 7, 'dev-b');
      const pendingA = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      const pendingB = await localRegistry.sendToolRequest(12, 'read_file', '{}', '/w', false, null);

      // 定向投递：tool_execute 只到 dev-a 的连接
      const framesA = (a.send as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => JSON.parse(c[0]));
      const framesB = (b.send as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => JSON.parse(c[0]));
      // 会话 11 绑 dev-a → 只到 A；会话 12 绑 dev-b → 只到 B
      expect(framesA.filter((f) => f.type === 'tool_execute' && f.sessionId === 11)).toHaveLength(1);
      expect(framesB.filter((f) => f.type === 'tool_execute' && f.sessionId === 11)).toHaveLength(0);
      expect(framesB.filter((f) => f.type === 'tool_execute' && f.sessionId === 12)).toHaveLength(1);
      expect(framesA.filter((f) => f.type === 'tool_execute' && f.sessionId === 12)).toHaveLength(0);

      // dev-a 断线：只失败 dev-a 的 pending（handler 用真实 registry，验证断线清理编排）
      const { handler } = makeHandler(new CapturingExecutor(), { registry: wsRegistry, localToolSessionRegistry: localRegistry });
      (a as { readyState: number }).readyState = 3;
      (handler as unknown as { afterConnectionClosed(s: WsSocket): void }).afterConnectionClosed(a);
      expect(await pendingA.future).toContain('Device disconnected');
      let doneB = false;
      void pendingB.future.then(() => { doneB = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(doneB).toBe(false);
      localRegistry.completeToolRequest(12, pendingB.requestId!, '{"ok":true}');
      expect(await pendingB.future).toBe('{"ok":true}');
    } finally {
      wsRegistry.shutdown();
    }
  });
});

describe('probe: skill sync direction', () => {
  it('sends skill_sync_required to the bound device only', async () => {
    const { handler, registry, localToolSessionRegistry } = makeHandler();
    localToolSessionRegistry.resolveTarget.mockResolvedValue({ userId: 7, deviceId: 'dev-a' });
    vi.useFakeTimers();
    try {
      const p = (handler as unknown as {
        syncSkillsToClient(u: number, s: number, session: Session, agent: unknown): Promise<string | null>;
      }).syncSkillsToClient(7, 11, session('LOCAL', 'RUNNING'), { id: 5, name: 'Coder' });
      await vi.advanceTimersByTimeAsync(61_000);
      const failure = await p;
      expect(failure).toContain('60');
      expect(registry.sendToDevice).toHaveBeenCalledWith(7, 'dev-a', expect.objectContaining({ type: 'skill_sync_required' }));
      expect(registry.sendToLocalClients).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('broadcasts when the session has no binding', async () => {
    const { handler, registry, localToolSessionRegistry } = makeHandler();
    localToolSessionRegistry.resolveTarget.mockResolvedValue({ userId: 7, deviceId: null });
    vi.useFakeTimers();
    try {
      const p = (handler as unknown as {
        syncSkillsToClient(u: number, s: number, session: Session, agent: unknown): Promise<string | null>;
      }).syncSkillsToClient(7, 11, session('LOCAL', 'RUNNING'), { id: 5, name: 'Coder' });
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      expect(registry.sendToLocalClients).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'skill_sync_required' }));
      expect(registry.sendToDevice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('probe: side session inherits binding', () => {
  it('creates the side session with the parent binding', async () => {
    const { handler, registry, sessionService, localToolSessionRegistry, harnessService, executor } = makeHandler();
    registry.getUserId.mockReturnValue(7);
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'IDLE', { targetDeviceId: 'dev-a', targetDeviceName: 'A' }));
    localToolSessionRegistry.resolveTarget.mockResolvedValue({ userId: 7, deviceId: 'dev-a' });
    registry.hasDeviceConnection.mockReturnValue(true);

    await handler.handleTextMessage(socket('ws-1'), JSON.stringify({
      type: 'create_side_session', sessionId: 11, data: { content: 'side work', contextMode: 'summary' },
    }));

    const saved = sessionService.save.mock.calls.at(-1)?.[0] as Session;
    expect(saved.executionMode).toBe('LOCAL');
    expect(saved.targetDeviceId).toBe('dev-a');
    expect(saved.targetDeviceName).toBe('A');
    expect(localToolSessionRegistry.setTargetForSession).toHaveBeenCalledWith(13, 7, 'dev-a');
  });
});

describe('probe: subscribe claims active unbound local session', () => {
  it('claims for the subscribing electron connection', async () => {
    const { handler, registry, sessionService, localToolSessionRegistry } = makeHandler();
    registry.getUserId.mockReturnValue(7);
    registry.getDeviceInfo.mockReturnValue({ id: 'dev-a', name: 'A', platform: 'darwin' });
    sessionService.getSession.mockResolvedValue(session('LOCAL', 'RUNNING', { platform: 'darwin' }));
    sessionService.claimTargetDevice.mockResolvedValue({ targetDeviceId: 'dev-a', targetDeviceName: 'A' });
    localToolSessionRegistry.resolveTarget.mockResolvedValue(null);

    await handler.handleTextMessage(socket('ws-1'), JSON.stringify({ type: 'subscribe', sessionId: 11 }));

    expect(sessionService.claimTargetDevice).toHaveBeenCalledWith(11, 'dev-a', 'A');
    expect(localToolSessionRegistry.setTargetForSession).toHaveBeenCalledWith(11, 7, 'dev-a');
  });
});
