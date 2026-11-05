import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from '../session/ws/streaming-ws-handler.js';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from '../session/ws/streaming-ws-registry.js';
import { LocalToolSessionRegistry } from '../harness/local/local-tool-session-registry.js';
import type { Session } from '../domain/types.js';

const OPEN = WS_OPEN;

function socket(id: string): WsSocket {
  return { id, readyState: OPEN, send: vi.fn(), close: vi.fn() };
}

function frames(s: WsSocket): Array<Record<string, any>> {
  return (s.send as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => JSON.parse(c[0]));
}

/** 极简内存 "DB"：claimTargetDevice 走 `WHERE target_device_id IS NULL` 语义。 */
function makeDbSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: 'LOCAL', phase: 'IDLE',
    permissionLevel: 'READ_WRITE', status: 'ACTIVE', workspace: '/repo', platform: 'darwin',
    ...overrides,
  } as Session;
}

function makeHarness(session: Session) {
  const registry = new StreamingWsRegistry(10_000);
  let dbRow = { ...session };
  const sessionMapper = {
    selectById: vi.fn(async (id: number) => (id === dbRow.id ? { ...dbRow } : null)),
  };
  const localRegistry = new LocalToolSessionRegistry(registry, sessionMapper as never);
  const executor = { tasks: [] as Array<() => void | Promise<void>>, submit(fn: () => void | Promise<void>) { this.tasks.push(fn); return fn; } };
  const sessionService = {
    getSession: vi.fn(async (id: number) => (id === dbRow.id ? { ...dbRow } : null)),
    saveMessage: vi.fn(async () => ({ id: 99, sessionId: dbRow.id, role: 'USER', content: 'x' })),
    updatePhase: vi.fn(async () => undefined),
    updateField: vi.fn(async () => undefined),
    updateModelId: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    editMessageAndTruncate: vi.fn(),
    save: vi.fn(async () => undefined),
    findOwnedMessage: vi.fn(async () => null),
    listSubagentSessions: vi.fn(async () => []),
    cleanupIncompleteTail: vi.fn(async () => 0),
    updateContextTokens: vi.fn(async () => undefined),
    getLastUserMessage: vi.fn(async () => null),
    deleteMessageById: vi.fn(async () => undefined),
    claimTargetDevice: vi.fn(async (_id: number, deviceId: string, deviceName: string | null) => {
      if (dbRow.targetDeviceId == null || dbRow.targetDeviceId === '') {
        dbRow = { ...dbRow, targetDeviceId: deviceId, targetDeviceName: deviceName };
      }
      return { targetDeviceId: dbRow.targetDeviceId ?? null, targetDeviceName: dbRow.targetDeviceName ?? null };
    }),
  };
  const deps = {
    registry,
    titleService: { scheduleForFirstUserMessage: vi.fn() },
    harnessService: {
      prepareMessage: vi.fn(async () => 'evt-1'), executeFromEvent: vi.fn(), executePrepared: vi.fn(),
      executeSideFirstMessage: vi.fn(), forkParentMessages: vi.fn(), requestCompaction: vi.fn(async () => true),
    },
    sessionService,
    taskTerminalService: { finishExecution: vi.fn() },
    messageQueueService: {
      listPending: vi.fn(async () => []), enqueue: vi.fn(), dequeue: vi.fn(), getById: vi.fn(),
      delete: vi.fn(), moveToIndex: vi.fn(), enqueueHead: vi.fn(async () => undefined),
    },
    onScheduledTaskQueueConsumed: vi.fn(),
    localToolSessionRegistry: localRegistry,
    askUserQuestionsRegistry: { failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []), complete: vi.fn() },
    embedPageToolRegistry: { request: vi.fn(), complete: vi.fn(), failSession: vi.fn(), isEmbedSession: vi.fn(() => false), hasBoundConnection: vi.fn(() => false), pendingCount: vi.fn(() => 0) },
    treeSignalPublisher: { publishIfSideTask: vi.fn(), publishForSession: vi.fn() },
    approvalRegistry: { unregister: vi.fn() },
    activityService: { record: vi.fn() },
    activityHeartbeat: { touch: vi.fn(), clear: vi.fn() },
    sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
    agentLoop: { registerCancelFlag: vi.fn(() => ({ get: () => false, set: () => {} })), removeCancelFlag: vi.fn(), requestCancel: vi.fn(), getCancelFlag: vi.fn() },
    shellSessionManager: { closeByConversation: vi.fn() },
    skillSyncService: { syncToSession: vi.fn(), getRemovedSkillNames: vi.fn(() => []) },
    localSkillRegistry: { report: vi.fn(), clear: vi.fn() },
    localAgentsMdRegistry: { report: vi.fn(), clear: vi.fn() },
    mcpSyncService: { loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})), clearSession: vi.fn(), clearLocalSession: vi.fn(), recordServerIdByName: vi.fn(), recordReport: vi.fn() },
    mcpClientManager: { closeSession: vi.fn() },
    agentMapper: { selectById: vi.fn(async () => ({ id: 5, name: 'Coder' })) },
    llmModelMapper: { selectById: vi.fn(), selectDefault: vi.fn() },
    jwtService: { getAccessTokenMetadata: vi.fn() },
    agentExecutor: (fn: () => void | Promise<void>) => executor.submit(fn),
    mcpSyncTimeoutSeconds: 5,
    compactionSignalBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };
  const handler = new StreamingWsHandler(deps as unknown as WsHandlerDeps);
  return { handler, registry, localRegistry, sessionService, executor, dbRow: () => dbRow };
}

const META = (userId: number) => ({ userId, expiresAt: Date.now() + 60_000 });

describe('probe: 浏览器在未绑定历史 LOCAL 会话上发送 → 认领 → 定向投递（真实注册表）', () => {
  it('browser + 唯一同平台在线设备：认领并只投递给该设备', async () => {
    const session = makeDbSession({ phase: 'IDLE' });
    const { handler, registry, localRegistry, sessionService, dbRow } = makeHarness(session);
    try {
      const browser = socket('ws-browser');
      const devA = socket('ws-a');
      registry.register(browser, 7, 'browser', META(7));
      registry.register(devA, 7, 'electron', META(7), true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });

      await handler.handleTextMessage(browser, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'hi' },
      }));

      expect(sessionService.claimTargetDevice).toHaveBeenCalledWith(11, 'dev-a', 'Mac A');
      expect(dbRow().targetDeviceId).toBe('dev-a');

      // 认领后工具请求只投递给 dev-a
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/repo', false, null);
      expect(pending.requestId).not.toBeNull();
      expect(frames(devA).filter((f) => f.type === 'tool_execute')).toHaveLength(1);
      expect(frames(browser).filter((f) => f.type === 'tool_execute')).toHaveLength(0);
    } finally {
      registry.shutdown();
    }
  });

  it('browser + 两台在线设备：拒绝执行、不发工具请求', async () => {
    const session = makeDbSession({ phase: 'IDLE' });
    const { handler, registry, localRegistry, sessionService } = makeHarness(session);
    try {
      const browser = socket('ws-browser');
      const devA = socket('ws-a');
      const devB = socket('ws-b');
      registry.register(browser, 7, 'browser', META(7));
      registry.register(devA, 7, 'electron', META(7), true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });
      registry.register(devB, 7, 'cli', META(7), true, { id: 'dev-b', name: 'mac-b', platform: 'darwin' });

      await handler.handleTextMessage(browser, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'hi' },
      }));

      expect(sessionService.claimTargetDevice).not.toHaveBeenCalled();
      const errors = frames(browser).filter((f) => f.type === 'error');
      expect(errors).toHaveLength(1);
      expect(String(errors[0].data.message)).toContain('macOS');
      expect(frames(devA).filter((f) => f.type === 'tool_execute')).toHaveLength(0);
      expect(frames(devB).filter((f) => f.type === 'tool_execute')).toHaveLength(0);
      // 未认领 → 工具请求仍走用户级广播（兼容边界）
      expect(await localRegistry.isConnected(11)).toBe(true);
    } finally {
      registry.shutdown();
    }
  });

  it('已绑定会话 + 绑定设备在线：浏览器发送后工具只到绑定设备', async () => {
    const session = makeDbSession({ targetDeviceId: 'dev-a', targetDeviceName: 'Mac A' });
    const { handler, registry, localRegistry, sessionService } = makeHarness(session);
    try {
      const browser = socket('ws-browser');
      const devA = socket('ws-a');
      const devB = socket('ws-b');
      registry.register(browser, 7, 'browser', META(7));
      registry.register(devA, 7, 'electron', META(7), true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });
      registry.register(devB, 7, 'electron', META(7), true, { id: 'dev-b', name: 'Win B', platform: 'win32' });

      await handler.handleTextMessage(browser, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'hi' },
      }));

      expect(sessionService.claimTargetDevice).not.toHaveBeenCalled();
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/repo', false, null);
      expect(pending.requestId).not.toBeNull();
      expect(frames(devA).filter((f) => f.type === 'tool_execute')).toHaveLength(1);
      expect(frames(devB).filter((f) => f.type === 'tool_execute')).toHaveLength(0);
    } finally {
      registry.shutdown();
    }
  });

  it('已绑定会话 + 绑定设备离线（另一台在线）：拒绝发送', async () => {
    const session = makeDbSession({ targetDeviceId: 'dev-a', targetDeviceName: 'Mac A' });
    const { handler, registry } = makeHarness(session);
    try {
      const browser = socket('ws-browser');
      const devB = socket('ws-b');
      registry.register(browser, 7, 'browser', META(7));
      registry.register(devB, 7, 'electron', META(7), true, { id: 'dev-b', name: 'Win B', platform: 'win32' });

      await handler.handleTextMessage(browser, JSON.stringify({
        type: 'send_message', sessionId: 11, data: { content: 'hi' },
      }));

      const errors = frames(browser).filter((f) => f.type === 'error');
      expect(errors).toHaveLength(1);
      expect(String(errors[0].data.message)).toContain('not connected');
      expect(frames(devB).filter((f) => f.type === 'tool_execute')).toHaveLength(0);
    } finally {
      registry.shutdown();
    }
  });
});
