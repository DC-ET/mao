import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { registerSessionRoutes } from './session.routes.js';
import type { SessionService } from './session.service.js';
import type { AgentHandoverService } from './agent-handover.service.js';
import type { AgentLookup, Session } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { ActivityService } from './activity.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { RunTraceService } from './run-trace.service.js';
import type { RunTraceRecordService } from './run-trace-record.service.js';
import type { SessionTodoRepository, SubagentExecutionRepository } from './activity.repository.js';

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    userId: 7,
    agentId: 9,
    title: 'hello',
    status: 'ACTIVE',
    phase: 'IDLE',
    executionMode: 'CLOUD',
    permissionLevel: 'FULL',
    workspace: '/tmp/ws',
    projectKey: 'demo',
    isGit: true,
    modelId: 3,
    unread: 0,
    elapsedMs: 0,
    createdAt: '2026-10-29 10:00:00',
    updatedAt: '2026-10-29 10:00:00',
    ...overrides,
  } as Session;
}

interface Harness {
  fastify: ReturnType<typeof Fastify>;
  sessionService: Record<string, ReturnType<typeof vi.fn>>;
  agentHandoverService: { generateHandoverNote: ReturnType<typeof vi.fn> };
}

async function app(currentSession: Session = baseSession()): Promise<Harness> {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    req.userId = 7;
    done();
  });
  const sessionService = {
    getSession: vi.fn(async () => currentSession),
    createSession: vi.fn(async (...args: unknown[]) => baseSession({ id: 77, agentId: args[1] as number, isGit: args[6] as boolean })),
    updateSessionAgent: vi.fn(),
    assertAgentSwitchable: vi.fn(),
    archiveSession: vi.fn(),
    updateTitle: vi.fn(),
    updateSummary: vi.fn(),
    updateProjectKey: vi.fn(),
    updatePermissionLevel: vi.fn(),
    updateMemoryInjectionDisabled: vi.fn(),
    updateModelId: vi.fn(),
    listSessions: vi.fn(async () => []),
    listSessionGroups: vi.fn(async () => []),
    listSideTaskSessions: vi.fn(async () => []),
    listDescendantSideTaskSessions: vi.fn(async () => []),
    listDescendantSideTaskSessionsByRoots: vi.fn(async () => new Map()),
    listSubagentSessionsWithSideTasks: vi.fn(async () => []),
    listSessionsForDashboard: vi.fn(async () => ({ running: [], recent: [] })),
    searchMessages: vi.fn(async () => ({ items: [], total: 0, page: 1, size: 20, path: 'LIKE' })),
    getMessagesByRounds: vi.fn(async () => ({ messages: [], hasMore: false, nextBeforeMessageId: null })),
    getFileChangesByMessageIds: vi.fn(async () => new Map()),
    getFileChangeSummariesByMessageIds: vi.fn(async () => new Map()),
    findOwnedMessage: vi.fn(async () => null),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const agentHandoverService = { generateHandoverNote: vi.fn(async () => '接手说明正文') };
  const agentLookup: AgentLookup = {
    findById: vi.fn(async () => ({ id: 9, name: 'Agent' })),
    findByIds: vi.fn(async () => [{ id: 9, name: 'Coder', defaultModelId: null }]),
    requireDefaultAgent: vi.fn(),
    listOptions: vi.fn(async () => [{ id: 9, name: 'Agent' }]),
  };
  registerSessionRoutes(fastify, {
    sessionService: sessionService as unknown as SessionService,
    agentHandoverService: agentHandoverService as unknown as AgentHandoverService,
    agentLookup,
    modelLookup: {
      findById: vi.fn(),
      findByIds: vi.fn(async () => []),
      findDefault: vi.fn(async () => ({ id: 3, name: 'gpt', supportsVision: 1, status: 1, isDefault: 1 })),
    },
    activityService: { listBySession: vi.fn(async () => []) } as unknown as ActivityService,
    todoRepo: {
      listBySession: vi.fn(async () => []),
      resetInProgressExcept: vi.fn(),
      updateFields: vi.fn(),
      logicalDelete: vi.fn(),
    } as unknown as SessionTodoRepository,
    messageQueueService: { listPending: vi.fn(async () => []) } as unknown as MessageQueueService,
    pathSandbox: { getWorkspaceRoot: () => '/tmp/root' } as PathSandbox,
    subagentExecutionRepo: { findByChildSessionIds: vi.fn(async () => []) } as unknown as SubagentExecutionRepository,
    sessionCompactionEventService: { listBySessionId: vi.fn(async () => []) } as unknown as SessionCompactionEventService,
    sessionCompactionService: { findBySessionId: vi.fn(async () => null) } as unknown as SessionCompactionService,
    runTraceService: { buildTrace: vi.fn(async () => ({ runs: [], hasMore: false, unattributed: null })) } as unknown as RunTraceService,
    runTraceRecordService: {
      buildToolRecord: vi.fn(async () => ({ toolCallId: 'x', toolName: null, argumentsJson: null, resultContent: null, resultMetadata: null, call: null })),
      buildCallRecord: vi.fn(async () => ({ call: null, tools: [], messages: [] })),
      buildMessageRecord: vi.fn(async () => ({ messageId: 1, role: 'USER', content: 'c', thinkingContent: null, tokenCount: 1, createdAt: '', updatedAt: '', edited: false })),
    } as unknown as RunTraceRecordService,
  });
  return { fastify, sessionService, agentHandoverService };
}

const json = async (
  fastify: Harness['fastify'],
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) => {
  const res = await fastify.inject({ method, url, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as { code: number; message?: string; data?: unknown } };
};

describe('PATCH /v1/sessions/:id agentId', () => {
  it('delegatesToServiceWhenAgentIdPresent', async () => {
    const { fastify, sessionService } = await app();
    const res = await json(fastify, 'PATCH', '/v1/sessions/1', { agentId: '5' });
    expect(res.body.code).toBe(0);
    expect(sessionService.updateSessionAgent).toHaveBeenCalledWith(1, 5);
  });

  it('skipsUpdateWhenAgentIdAbsent', async () => {
    const { fastify, sessionService } = await app();
    const res = await json(fastify, 'PATCH', '/v1/sessions/1', { title: 'n' });
    expect(res.body.code).toBe(0);
    expect(sessionService.updateSessionAgent).not.toHaveBeenCalled();
  });

  it('skipsUpdateWhenAgentIdNotNumeric', async () => {
    const { fastify, sessionService } = await app();
    await json(fastify, 'PATCH', '/v1/sessions/1', { agentId: 'abc' });
    expect(sessionService.updateSessionAgent).not.toHaveBeenCalled();
  });
});

describe('POST /v1/sessions/:id/reopen-with-agent', () => {
  it('createsSiblingSessionCarriesOverAttributesArchivesOldAndReturnsNote', async () => {
    const { fastify, sessionService, agentHandoverService } = await app();
    const res = await json(fastify, 'POST', '/v1/sessions/1/reopen-with-agent', { agentId: '5' });
    expect(res.body.code).toBe(0);
    expect(sessionService.assertAgentSwitchable).toHaveBeenCalledWith(5);
    const createArgs = vi.mocked(sessionService.createSession).mock.calls[0] as unknown[];
    expect(createArgs[0]).toBe(7);
    expect(createArgs[1]).toBe(5);
    expect(createArgs[2]).toBe('未命名会话');
    expect(createArgs[3]).toBe('CLOUD');
    expect(createArgs[4]).toBe('/tmp/ws');
    expect(createArgs[5]).toBe('FULL');
    expect(createArgs[6]).toBe(true);
    expect(createArgs[10]).toBe(3);
    expect(createArgs[11]).toBe('demo');
    expect(createArgs[12]).toBe('existing');
    expect(createArgs[15]).toBe('web');
    expect(agentHandoverService.generateHandoverNote).toHaveBeenCalledTimes(1);
    expect(sessionService.archiveSession).toHaveBeenCalledWith(1);
    expect(res.body.data).toEqual({ sessionId: 77, handoverNote: '接手说明正文' });
  });

  it('stillCreatesAndArchivesWhenNoteGenerationFails', async () => {
    const { fastify, sessionService, agentHandoverService } = await app();
    agentHandoverService.generateHandoverNote.mockResolvedValue(null);
    const res = await json(fastify, 'POST', '/v1/sessions/1/reopen-with-agent', { agentId: '5' });
    expect(res.body.code).toBe(0);
    // ok() 信封对 null 数据字段是「省略」语义：客户端按 falsy 判定
    expect(res.body.data).toMatchObject({ sessionId: 77 });
    expect((res.body.data as { handoverNote?: string | null }).handoverNote ?? null).toBeNull();
    expect(sessionService.archiveSession).toHaveBeenCalledWith(1);
  });

  it('rejectsLocalSession', async () => {
    const { fastify, sessionService } = await app(baseSession({ executionMode: 'LOCAL' }));
    const res = await json(fastify, 'POST', '/v1/sessions/1/reopen-with-agent', { agentId: '5' });
    expect(res.body.code).toBe(2001);
    expect(res.body.message).toBe('仅 CLOUD 会话支持用其他 Agent 重开');
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('rejectsMissingAgentId', async () => {
    const { fastify, sessionService } = await app();
    const res = await json(fastify, 'POST', '/v1/sessions/1/reopen-with-agent', {});
    expect(res.body.code).toBe(2002);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('propagatesAgentSwitchableFailure', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.assertAgentSwitchable).mockRejectedValue(
      new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用'),
    );
    const res = await json(fastify, 'POST', '/v1/sessions/1/reopen-with-agent', { agentId: '5' });
    expect(res.body.code).toBe(2001);
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(sessionService.archiveSession).not.toHaveBeenCalled();
  });
});
