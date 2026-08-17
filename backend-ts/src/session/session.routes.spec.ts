import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerSessionRoutes } from './session.routes.js';
import { registerAdminSessionRoutes } from './admin-session.routes.js';
import { registerOssRoutes } from '../oss/oss.routes.js';
import type { SessionService } from './session.service.js';
import type { ActivityService } from './activity.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';
import type { SessionTodoRepository, SubagentExecutionRepository } from './activity.repository.js';
import type { AgentLookup, LlmModelLookup, UserLookup } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { OssStsService } from '../oss/oss-sts.service.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 7,
    agentId: 9,
    title: 'hello',
    status: 'ACTIVE',
    phase: 'IDLE',
    isPinned: 0,
    isFavorite: 0,
    unread: 0,
    elapsedMs: 0,
    createdAt: '2026-08-13 10:00:00',
    updatedAt: '2026-08-13 10:00:00',
    ...overrides,
  };
}

describe('session and admin routes', () => {
  async function app() {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      createSession: vi.fn(async () => session()),
      getSession: vi.fn(async () => session()),
      listSessions: vi.fn(async () => [session()]),
      listSessionGroups: vi.fn(async () => []),
      listSessionsByGroup: vi.fn(),
      searchSessionsByUserMessage: vi.fn(async () => []),
      listSessionsForDashboard: vi.fn(async () => ({ running: [], recent: [] })),
      listSideTaskSessions: vi.fn(async () => []),
      listSubagentSessionsWithSideTasks: vi.fn(async () => []),
      listSideTasksByParentIds: vi.fn(async () => []),
      deleteSession: vi.fn(),
      promoteSideTaskToMainSession: vi.fn(async () => session({ id: 2, sessionType: 'NORMAL', parentSessionId: null })),
      togglePin: vi.fn(),
      toggleFavorite: vi.fn(),
      archiveSession: vi.fn(),
      unarchiveSession: vi.fn(),
      markAsRead: vi.fn(),
      updateTitle: vi.fn(),
      updateSummary: vi.fn(),
      updateProjectKey: vi.fn(),
      updatePermissionLevel: vi.fn(),
      updateModelId: vi.fn(),
      getMessagesByRounds: vi.fn(async () => ({ messages: [], hasMore: false, nextBeforeMessageId: null })),
      getFileChangesByMessageIds: vi.fn(async () => new Map()),
      editMessageAndTruncate: vi.fn(async () => ({ id: 2, sessionId: 1, role: 'USER', content: 'edited' })),
      listSessionsForAdmin: vi.fn(async () => ({ records: [session()], total: 1, current: 1, size: 20 })),
    } as unknown as SessionService;
    const agentLookup: AgentLookup = {
      findById: vi.fn(async () => ({ id: 9, name: 'Agent' })),
      findByIds: vi.fn(async () => [{ id: 9, name: 'Coder' }]),
      requireDefaultAgent: vi.fn(),
      listOptions: vi.fn(async () => [{ id: 9, name: 'Agent' }]),
    };
    const modelLookup: LlmModelLookup = {
      findById: vi.fn(),
      findByIds: vi.fn(async () => []),
      findDefault: vi.fn(async () => ({ id: 3, name: 'gpt', supportsVision: 1, status: 1, isDefault: 1 })),
    };
    const userLookup: UserLookup = {
      findByIds: vi.fn(async () => [{ id: 7, username: 'u', displayName: 'User' }]),
      listOptions: vi.fn(async () => [{ id: 7, username: 'u', displayName: 'User' }]),
    };
    const root = await mkdtemp(join(tmpdir(), 'mao-sess-'));
    mkdirSync(join(root, '7', 'projects', 'demo'), { recursive: true });
    writeFileSync(join(root, '7', 'projects', 'demo', '.git'), '');
    const pathSandbox = { getWorkspaceRoot: () => root } as PathSandbox;
    registerSessionRoutes(fastify, {
      sessionService,
      agentLookup,
      modelLookup,
      activityService: { listBySession: vi.fn(async () => []) } as unknown as ActivityService,
      todoRepo: {
        listBySession: vi.fn(async () => []),
        resetInProgressExcept: vi.fn(),
        updateFields: vi.fn(),
        logicalDelete: vi.fn(),
      } as unknown as SessionTodoRepository,
      messageQueueService: { listPending: vi.fn(async () => []) } as unknown as MessageQueueService,
      pathSandbox,
      subagentExecutionRepo: { findByChildSessionIds: vi.fn(async () => []) } as unknown as SubagentExecutionRepository,
      sessionCompactionEventService: { listBySessionId: vi.fn(async () => []) } as unknown as SessionCompactionEventService,
    });
    registerAdminSessionRoutes(fastify, { sessionService, userLookup, agentLookup, modelLookup });
    const ossStsService = {
      generateStsToken: vi.fn(async () => ({
        accessKeyId: 'a', accessKeySecret: 'b', securityToken: 'c', expiration: 'e',
        bucket: 'bucket', region: 'cn-hangzhou', uploadDir: 'uploads/',
      })),
    } as unknown as OssStsService;
    registerOssRoutes(fastify, { ossStsService });
    return { fastify, sessionService, ossStsService };
  }

  it('covers session rest endpoints', async () => {
    const { fastify, sessionService } = await app();
    const json = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const res = await fastify.inject({ method, url, payload });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    expect((await json('POST', '/v1/sessions', { title: 't', agentId: '9' })).body.data.agentName).toBe('Coder');
    expect((await json('GET', '/v1/sessions')).body.data).toHaveLength(1);
    expect((await json('GET', '/v1/sessions/groups')).body.data.groups).toEqual([]);
    expect((await json('GET', '/v1/sessions/search?keyword=hi')).body.data.items).toEqual([]);
    expect((await json('GET', '/v1/sessions/dashboard')).body.data.running).toEqual([]);
    const projects = await json('GET', '/v1/sessions/cloud-projects');
    expect(projects.body.data[0].name).toBe('demo');
    expect(projects.body.data[0].isGit).toBe(true);
    expect((await json('GET', '/v1/sessions/1')).body.data.id).toBe(1);
    expect((await json('DELETE', '/v1/sessions/1')).body.code).toBe(0);
    expect((await json('POST', '/v1/sessions/1/promote-side-task')).body.data.id).toBe(2);
    expect((await json('PUT', '/v1/sessions/1/pin')).body.code).toBe(0);
    expect((await json('PUT', '/v1/sessions/1/favorite')).body.code).toBe(0);
    expect((await json('PUT', '/v1/sessions/1/archive')).body.code).toBe(0);
    expect((await json('PUT', '/v1/sessions/1/unarchive')).body.code).toBe(0);
    expect((await json('PUT', '/v1/sessions/1/read')).body.code).toBe(0);
    expect((await json('PATCH', '/v1/sessions/1', { title: 'n' })).body.code).toBe(0);
    expect((await json('GET', '/v1/sessions/1/side-tasks')).body.data).toEqual([]);
    expect((await json('GET', '/v1/sessions/1/subagents')).body.data).toEqual([]);
    expect((await json('GET', '/v1/sessions/1/messages')).body.data.messages).toEqual([]);
    expect((await json('PATCH', '/v1/sessions/1/messages/2', { content: 'x' })).body.data.content).toBe('edited');
    expect((await json('GET', '/v1/sessions/1/activities')).body.data).toEqual([]);
    expect((await json('GET', '/v1/sessions/1/todos')).body.data).toEqual([]);
    expect((await json('PATCH', '/v1/sessions/1/todos/3', { status: 'in_progress' })).body.code).toBe(0);
    expect((await json('DELETE', '/v1/sessions/1/todos/3')).body.code).toBe(0);
    expect((await json('GET', '/v1/sessions/1/queue')).body.data).toEqual([]);
    expect((await json('GET', '/v1/admin/sessions')).body.data.total).toBe(1);
    expect((await json('GET', '/v1/admin/sessions/1')).body.data.id).toBe(1);
    expect((await json('GET', '/v1/admin/sessions/1/messages')).body.data.messages).toEqual([]);
    expect((await json('GET', '/v1/admin/sessions/options/users')).body.data[0].username).toBe('u');
    expect((await json('GET', '/v1/admin/sessions/options/agents')).body.data[0].name).toBe('Agent');
    expect(sessionService.togglePin).toHaveBeenCalled();
    await fastify.close();
  });

  it('resolves agentName when create payload and session agentId are strings', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.createSession).mockResolvedValue(session({ agentId: '9' as unknown as number }));
    vi.mocked(sessionService.getSession).mockResolvedValue(session({ agentId: '9' as unknown as number }));
    const created = JSON.parse((await fastify.inject({
      method: 'POST', url: '/v1/sessions', payload: { title: 't', agentId: '9' },
    })).body);
    expect(created.data.agentName).toBe('Coder');
    expect(vi.mocked(sessionService.createSession).mock.calls[0][1]).toBe(9);
    const detail = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/sessions/1' })).body);
    expect(detail.data.agentName).toBe('Coder');
    await fastify.close();
  });

  it('issuesOssStsToken', async () => {
    const { fastify } = await app();
    const res = await fastify.inject({ method: 'POST', url: '/v1/oss/sts-token', payload: { sessionId: 1 } });
    expect(JSON.parse(res.body).data.uploadDir).toBe('uploads/');
    await fastify.close();
  });
});
