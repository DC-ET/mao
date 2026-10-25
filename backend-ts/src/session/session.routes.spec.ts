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
import type { SessionCompactionService } from './session-compaction.service.js';
import type { RunTraceService } from './run-trace.service.js';
import type { RunTraceRecordService } from './run-trace-record.service.js';
import type { SessionTodoRepository, SubagentExecutionRepository } from './activity.repository.js';
import type { AgentLookup, LlmModelLookup, UserLookup } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { OssStsService } from '../oss/oss-sts.service.js';
import { useTmpDir } from '../testing/tmp-dir.js';
import { InFlightToolRegistry } from '../harness/core/in-flight-tool-registry.js';
import { join } from 'node:path';
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
      listSessionsByFilter: vi.fn(async () => ({ items: [session({ source: 'embed' })], total: 1, offset: 0, limit: 20, hasMore: false })),
      markSessionSource: vi.fn(async () => session({ source: 'embed' })),
      searchMessages: vi.fn(async () => ({ items: [], total: 0, page: 1, size: 20, path: 'LIKE' })),
      listSessionsForDashboard: vi.fn(async () => ({ running: [], recent: [] })),
      listSideTaskSessions: vi.fn(async () => []),
      listDescendantSideTaskSessions: vi.fn(async () => []),
      listDescendantSideTaskSessionsByRoots: vi.fn(async () => new Map()),
      listSubagentSessionsWithSideTasks: vi.fn(async () => []),
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
      updateMemoryInjectionDisabled: vi.fn(),
      updateModelId: vi.fn(),
      getMessagesByRounds: vi.fn(async () => ({ messages: [], hasMore: false, nextBeforeMessageId: null })),
      getFileChangesByMessageIds: vi.fn(async () => new Map()),
      getFileChangeSummariesByMessageIds: vi.fn(async () => new Map()),
      getMessageAttachment: vi.fn(async () => ({ mime: 'image/png', bytes: Buffer.from('img') })),
      findOwnedMessage: vi.fn(async () => null),
      getForkPreview: vi.fn(async () => ({ messages: [], hasMore: false, nextBeforeMessageId: null })),
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
    const root = useTmpDir('mao-sess-');
    mkdirSync(join(root, '7', 'projects', 'demo'), { recursive: true });
    writeFileSync(join(root, '7', 'projects', 'demo', '.git'), '');
    const pathSandbox = { getWorkspaceRoot: () => root } as PathSandbox;
    const compactionEventService = { listBySessionId: vi.fn(async () => []) } as unknown as SessionCompactionEventService;
    const compactionRecordService = { findBySessionId: vi.fn(async () => null) };
    const runTraceService = { buildTrace: vi.fn(async () => ({ runs: [], hasMore: false, unattributed: null })) };
    const runTraceRecordService = {
      buildToolRecord: vi.fn(async (sessionId: number, toolCallId: string) => ({
        toolCallId, toolName: null, argumentsJson: null, resultContent: null, resultMetadata: null, call: null,
      })),
      buildCallRecord: vi.fn(async () => ({ call: null, tools: [] as unknown[], messages: [] })),
      buildMessageRecord: vi.fn(async (_sessionId: number, messageId: number) => ({
        messageId, role: 'USER', content: '消息原文', thinkingContent: null,
        tokenCount: 12, createdAt: '2026-10-22 10:00:00', updatedAt: '2026-10-22 10:00:00', edited: false,
      })),
    };
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
      sessionCompactionEventService: compactionEventService,
      sessionCompactionService: compactionRecordService as unknown as SessionCompactionService,
      runTraceService: runTraceService as unknown as RunTraceService,
      runTraceRecordService: runTraceRecordService as unknown as RunTraceRecordService,
    });
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup,
      agentLookup,
      modelLookup,
      permissionService: { hasPermission: vi.fn(async () => true) },
      // 等待用户回答的问答计数来自内存注册表（phase 仍为 RUNNING），管理端展示据此覆盖文案
      askUserQuestionsRegistry: {
        countPendingBySessionIds: vi.fn(() => new Map([[1, 2]])),
        getPendingForSession: vi.fn(() => []),
      },
    });
    const ossStsService = {
      generateStsToken: vi.fn(async () => ({
        accessKeyId: 'a', accessKeySecret: 'b', securityToken: 'c', expiration: 'e',
        bucket: 'bucket', region: 'cn-hangzhou', uploadDir: 'uploads/',
      })),
    } as unknown as OssStsService;
    registerOssRoutes(fastify, { ossStsService });
    return { fastify, sessionService, ossStsService, compactionEvents: compactionEventService, compactionRecordService, runTraceService, runTraceRecordService, root };
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
    expect((await json('GET', '/v1/admin/sessions')).body.data.records[0].pendingQuestionCount).toBe(2);
    expect((await json('GET', '/v1/admin/sessions/1')).body.data.id).toBe(1);
    expect((await json('GET', '/v1/admin/sessions/1')).body.data.pendingQuestionCount).toBe(2);
    expect((await json('GET', '/v1/admin/sessions/1/messages')).body.data.messages).toEqual([]);
    expect((await json('GET', '/v1/admin/sessions/options/users')).body.data[0].username).toBe('u');
    expect((await json('GET', '/v1/admin/sessions/options/agents')).body.data[0].name).toBe('Agent');
    expect(sessionService.togglePin).toHaveBeenCalled();
    expect(sessionService.getFileChangeSummariesByMessageIds).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('GET /sessions/:id/compaction 返回摘要现值，无记录时 data 为 null', async () => {
    const { fastify, compactionRecordService } = await app();

    // 无压缩记录：data 缺省（框架 Result.ok 对 null 省略 data 键），不算错
    const none = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/compaction' });
    expect(none.statusCode).toBe(200);
    const noneBody = JSON.parse(none.body);
    expect(noneBody.code).toBe(0);
    expect(noneBody.data ?? null).toBeNull();

    // 有记录：透传 summaryText / lastCompactedMsgId / compactCount / compactModel / updatedAt
    // updatedAt 用 MySQL dateStrings 的 'yyyy-MM-dd HH:mm:ss' 字符串形态，格式化结果与时区无关。
    (compactionRecordService.findBySessionId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        summaryText: '这是上下文摘要',
        lastCompactedMsgId: 42,
        compactCount: 3,
        compactModel: 'gpt-test',
        updatedAt: '2026-10-06 12:00:00',
      });
    const got = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/sessions/1/compaction' })).body);
    expect(got.data).toEqual({
      summaryText: '这是上下文摘要',
      lastCompactedMsgId: 42,
      compactCount: 3,
      compactModel: 'gpt-test',
      updatedAt: '2026-10-06T12:00',
    });

    // 属主校验：越权会话拒绝（requireSessionOwner 抛 FORBIDDEN）
    const { fastify: f2, sessionService: svc2 } = await app();
    (svc2.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, userId: 999, agentId: 9 });
    const denied = await f2.inject({ method: 'GET', url: '/v1/sessions/1/compaction' });
    expect(denied.statusCode).not.toBe(200);
    expect(JSON.parse(denied.body).code).not.toBe(0);

    await fastify.close();
    await f2.close();
  });

  it('GET /sessions/:id/trace 透传分页锚点并钳制慢 / 贵阈值', async () => {
    const { fastify, runTraceService } = await app();
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace?beforeRunId=9&limit=50&slowMs=10&expensiveCost=99999' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    expect(runTraceService.buildTrace).toHaveBeenCalledWith(1, {
      beforeRunId: 9,
      limit: 50,
      slowMs: 1_000,
      expensiveCost: 1000,
      expensiveCostMicros: 1_000_000_000,
    });

    // 小数阈值原样透传：0.5 元 = 500000 micros，不能被整数 clamp 取整成 0
    vi.mocked(runTraceService.buildTrace).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace?expensiveCost=0.5' });
    expect(runTraceService.buildTrace).toHaveBeenCalledWith(1, expect.objectContaining({
      expensiveCost: 0.5,
      expensiveCostMicros: 500_000,
    }));

    // 缺省值：limit=5、slowMs=60s、贵阈值 0.5 元
    vi.mocked(runTraceService.buildTrace).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace' });
    expect(runTraceService.buildTrace).toHaveBeenCalledWith(1, {
      beforeRunId: null,
      limit: 5,
      slowMs: 60_000,
      expensiveCost: 0.5,
      expensiveCostMicros: 500_000,
    });

    // limit 下限也要钳：0 / 负值会让 service 把「本页被裁空」误判成「会话没有用户消息」，
    // 整会话调用倒进未归属且 hasMore=false
    for (const bad of ['0', '-5']) {
      vi.mocked(runTraceService.buildTrace).mockClear();
      await fastify.inject({ method: 'GET', url: `/v1/sessions/1/trace?limit=${bad}` });
      expect(vi.mocked(runTraceService.buildTrace).mock.calls[0][1]).toMatchObject({ limit: 1 });
    }

    // 越权会话拒绝（requireSessionOwner 抛 FORBIDDEN）
    const { fastify: f2, sessionService: svc2 } = await app();
    (svc2.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, userId: 999, agentId: 9 });
    const denied = await f2.inject({ method: 'GET', url: '/v1/sessions/1/trace' });
    expect(denied.statusCode).not.toBe(200);
    expect(JSON.parse(denied.body).code).not.toBe(0);

    await fastify.close();
    await f2.close();
  });

  // 记录详情下钻（技术方案 2026-10-22-run-trace-deep-dive §5.4）：两个端点按 key 分流，
  // 路径参数非法走空态 VO（200），不抛 404/500；归属复用 requireSessionOwner。
  it('GET /trace/records/tool/:toolCallId 透传 key，非法 toolCallId 走空态 VO', async () => {
    const { fastify, runTraceRecordService } = await app();
    const ok = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace/records/tool/call_1' });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).code).toBe(0);
    expect(JSON.parse(ok.body).data.toolCallId).toBe('call_1');
    expect(runTraceRecordService.buildToolRecord).toHaveBeenCalledWith(1, 'call_1');

    // 超长 toolCallId 由 Fastify 的 URL 上限先拒（414），路由内的长度钳制是深层防御：
    // 即使将来 URL 上限放宽，service 侧同样按空态 VO 处理，不会把超长串带进 LIKE 查询。
    vi.mocked(runTraceRecordService.buildToolRecord).mockClear();
    const long = 'x'.repeat(129);
    const tooLong = await fastify.inject({ method: 'GET', url: `/v1/sessions/1/trace/records/tool/${long}` });
    expect(tooLong.statusCode).toBe(414);
    expect(runTraceRecordService.buildToolRecord).not.toHaveBeenCalled();

    await fastify.close();
  });

  it('GET /trace/records/call/:llmCallId 只接受正整数，其余走空态 VO', async () => {
    const { fastify, runTraceRecordService } = await app();
    const ok = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace/records/call/42' });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).code).toBe(0);
    expect(runTraceRecordService.buildCallRecord).toHaveBeenCalledWith(1, 42);

    for (const bad of ['0', '-5', 'abc', '1.5']) {
      vi.mocked(runTraceRecordService.buildCallRecord).mockClear();
      const res = await fastify.inject({ method: 'GET', url: `/v1/sessions/1/trace/records/call/${bad}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).code).toBe(0);
      expect(runTraceRecordService.buildCallRecord).toHaveBeenCalledWith(1, 0);
    }

    await fastify.close();
  });

  it('记录详情端点对越权会话拒绝（与 /trace 同一归属口径）', async () => {
    const { fastify, sessionService } = await app();
    (sessionService.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, userId: 999, agentId: 9 });
    const tool = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace/records/tool/call_1' });
    expect(tool.statusCode).not.toBe(200);
    expect(JSON.parse(tool.body).code).not.toBe(0);
    const call = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace/records/call/42' });
    expect(call.statusCode).not.toBe(200);
    expect(JSON.parse(call.body).code).not.toBe(0);
    await fastify.close();
  });

  it('PATCH /sessions/:id 切换 memoryInjectionDisabled（含 false）并回显到 VO', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.getSession).mockResolvedValue(session({ memoryInjectionDisabled: 1 }) as never);
    const on = await fastify.inject({ method: 'PATCH', url: '/v1/sessions/1', payload: { memoryInjectionDisabled: true } });
    expect(on.statusCode).toBe(200);
    expect(JSON.parse(on.body).data.memoryInjectionDisabled).toBe(true);
    expect(sessionService.updateMemoryInjectionDisabled).toHaveBeenCalledWith(1, true);

    // false 也必须触发写入（关闭开关），不能因为 `!= null` 短路被当成缺省跳过。
    const off = await fastify.inject({ method: 'PATCH', url: '/v1/sessions/1', payload: { memoryInjectionDisabled: false } });
    expect(off.statusCode).toBe(200);
    expect(sessionService.updateMemoryInjectionDisabled).toHaveBeenCalledWith(1, false);
    await fastify.close();
  });

  it('side-tasks recursive returns flattened descendants with parentSessionId', async () => {
    const { fastify, sessionService } = await app();
    const deep = session({ id: 30, parentSessionId: 20, permissionLevel: 'READ_ONLY', phase: 'RUNNING' });
    vi.mocked(sessionService.listDescendantSideTaskSessions).mockResolvedValue([deep as never]);
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/side-tasks?recursive=1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(30);
    expect(body.data[0].parentSessionId).toBe(20);
    expect(body.data[0].permissionLevel).toBe('READ_ONLY');
    expect(sessionService.listDescendantSideTaskSessions).toHaveBeenCalledWith(1, 7);
    expect(sessionService.listSideTaskSessions).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('fork-preview returns cut-scoped messages and a page cursor', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.findOwnedMessage).mockResolvedValue({ id: 5, sessionId: 1, role: 'ASSISTANT', content: 'done' } as never);
    vi.mocked(sessionService.getForkPreview).mockResolvedValue({
      messages: [
        { id: 1, sessionId: 1, role: 'USER', content: 'q', createdAt: '2026-08-13 10:00:00' },
        { id: 5, sessionId: 1, role: 'ASSISTANT', content: 'done', createdAt: '2026-08-13 10:01:00' },
      ],
      hasMore: true,
      nextBeforeMessageId: 1,
    });
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/fork-preview?forkFromMessageId=5' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(sessionService.getForkPreview).toHaveBeenCalledWith(1, 5, 5, null);
    expect(body.data.messages).toHaveLength(2);
    expect(body.data.messages[1].content).toBe('done');
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextBeforeMessageId).toBe(1);
    expect(body.data.compactionEvents).toEqual([]);
    await fastify.close();
  });

  it('fork-preview without cut point previews the whole history', async () => {
    const { fastify, sessionService } = await app();
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/fork-preview' });
    expect(res.statusCode).toBe(200);
    expect(sessionService.getForkPreview).toHaveBeenCalledWith(1, null, 5, null);
    expect(sessionService.findOwnedMessage).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).data.messages).toEqual([]);
    await fastify.close();
  });

  it('fork-preview forwards the paging cursor when loading older rounds', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.findOwnedMessage).mockResolvedValue({ id: 5, sessionId: 1, role: 'ASSISTANT', content: 'x' } as never);
    const res = await fastify.inject({
      method: 'GET',
      url: '/v1/sessions/1/fork-preview?forkFromMessageId=5&beforeMessageId=42',
    });
    expect(res.statusCode).toBe(200);
    expect(sessionService.getForkPreview).toHaveBeenCalledWith(1, 5, 5, 42);
    await fastify.close();
  });

  it('fork-preview drops compaction markers past the cut point', async () => {
    const { fastify, sessionService, compactionEvents } = await app();
    vi.mocked(sessionService.findOwnedMessage).mockResolvedValue({ id: 5, sessionId: 1, role: 'ASSISTANT', content: 'x' } as never);
    // 两条标记：boundary=1 落在切点内（落库侧会复制，预览要保留）；boundary=99 落在切点外（不复制，预览要挡掉）
    vi.mocked(compactionEvents.listBySessionId).mockResolvedValue([
      { id: 1, sessionId: 1, triggerMode: 'AUTO', prevBoundaryMsgId: 0, boundaryMsgId: 1, compactedMessageCount: 1 },
      { id: 2, sessionId: 1, triggerMode: 'AUTO', prevBoundaryMsgId: 1, boundaryMsgId: 99, compactedMessageCount: 1 },
    ] as never);
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/fork-preview?forkFromMessageId=5' });
    expect(res.statusCode).toBe(200);
    const events = JSON.parse(res.body).data.compactionEvents;
    expect(events).toHaveLength(1);
    expect(events[0].boundaryMsgId).toBe(1);
    await fastify.close();
  });

  it('fork-preview rejects a foreign or missing cut point before loading history', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.findOwnedMessage).mockResolvedValue(null as never);
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/fork-preview?forkFromMessageId=99' });
    expect(JSON.parse(res.body).code).toBe(3030);
    expect(sessionService.getForkPreview).not.toHaveBeenCalled();
    const invalid = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/fork-preview?forkFromMessageId=0' });
    expect(JSON.parse(invalid.body).code).toBe(2001);
    expect(sessionService.getForkPreview).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('side-tasks default keeps direct children behavior', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.listSideTaskSessions).mockResolvedValue([session({ id: 20, parentSessionId: 1 })] as never);
    const res = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/side-tasks' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].id).toBe(20);
    expect(sessionService.listDescendantSideTaskSessions).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('admin message compact omits diff payload and truncates tool output', async () => {
    const { fastify, sessionService } = await app();
    vi.mocked(sessionService.getMessagesByRounds).mockResolvedValue({
      messages: [{
        id: 8,
        sessionId: 1,
        role: 'TOOL',
        content: `{"stdout":"${'a'.repeat(5000)}","exit_code":1}`,
        toolCallId: 'c1',
      }],
      hasMore: false,
      nextBeforeMessageId: null,
    });
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/1/messages?compact=true' });
    const body = JSON.parse(res.body);
    expect(sessionService.getFileChangeSummariesByMessageIds).toHaveBeenCalled();
    expect(sessionService.getFileChangesByMessageIds).not.toHaveBeenCalled();
    expect(body.data.messages[0].content.startsWith('Tool execution failed')).toBe(true);
    expect(body.data.messages[0].content.length).toBeLessThanOrEqual(4000);
    expect(body.data.messages[0].content).toContain('已截断');
    await fastify.close();
  });

  it('admin messages append in-flight tool calls only on the latest page', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{ id: 12, sessionId: 1, role: 'ASSISTANT', content: '先跑一下命令', toolCalls: null }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      getFileChangesByMessageIds: vi.fn(async () => new Map()),
      getFileChangeSummariesByMessageIds: vi.fn(async () => new Map()),
    } as unknown as SessionService;
    const inFlightToolRegistry = new InFlightToolRegistry();
    inFlightToolRegistry.start(1, {
      id: 'call-live',
      name: 'shell',
      arguments: JSON.stringify({ command: 'npm run build' }),
    });
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as never,
      agentLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), requireDefaultAgent: vi.fn(), listOptions: vi.fn(async () => []) } as never,
      modelLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), findDefault: vi.fn(async () => null) } as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
      inFlightToolRegistry,
    });

    const latest = JSON.parse((await fastify.inject({
      method: 'GET', url: '/v1/admin/sessions/1/messages',
    })).body);
    expect(latest.data.messages).toHaveLength(2);
    const pending = latest.data.messages[1];
    expect(pending.id).toBe('pending-tool-call-live');
    expect(pending.role).toBe('ASSISTANT');
    const toolCalls = JSON.parse(pending.toolCalls) as Array<{ id: string; name: string; status: string; input: { command?: string } }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ id: 'call-live', name: 'shell', status: 'running' });
    expect(toolCalls[0].input.command).toBe('npm run build');

    // 执行结束（注销）后不再补卡片
    inFlightToolRegistry.finish(1, 'call-live');
    const after = JSON.parse((await fastify.inject({
      method: 'GET', url: '/v1/admin/sessions/1/messages',
    })).body);
    expect(after.data.messages).toHaveLength(1);

    const older = JSON.parse((await fastify.inject({
      method: 'GET', url: '/v1/admin/sessions/1/messages?beforeMessageId=5',
    })).body);
    expect(older.data.messages).toHaveLength(1);
    expect(older.data.messages[0].id).toBe(12);
    await fastify.close();
  });

  it('admin messages append pending ask_user_questions only on the latest page', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{ id: 10, sessionId: 1, role: 'ASSISTANT', content: '我来确认几件事', toolCalls: null }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      getFileChangesByMessageIds: vi.fn(async () => new Map()),
      getFileChangeSummariesByMessageIds: vi.fn(async () => new Map()),
    } as unknown as SessionService;
    const questionRegistry = {
      countPendingBySessionIds: vi.fn(() => new Map([[1, 1]])),
      getPendingForSession: vi.fn(() => [{
        requestId: 'req-live',
        questions: [{ question: '选哪个租户？' }],
        metadata: null,
      }]),
    };
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as never,
      agentLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), requireDefaultAgent: vi.fn(), listOptions: vi.fn(async () => []) } as never,
      modelLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), findDefault: vi.fn(async () => null) } as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
      askUserQuestionsRegistry: questionRegistry,
    });

    const latest = JSON.parse((await fastify.inject({
      method: 'GET', url: '/v1/admin/sessions/1/messages',
    })).body);
    expect(latest.data.messages).toHaveLength(2);
    const pending = latest.data.messages[1];
    expect(pending.id).toBe('pending-ask-req-live');
    expect(pending.role).toBe('ASSISTANT');
    const toolCalls = JSON.parse(pending.toolCalls) as Array<{ id: string; name: string; status: string; input: { questions: unknown[] } }>;
    expect(toolCalls[0]).toMatchObject({ id: 'req-live', name: 'ask_user_questions', status: 'running' });
    expect(toolCalls[0].input.questions).toEqual([{ question: '选哪个租户？' }]);

    const older = JSON.parse((await fastify.inject({
      method: 'GET', url: '/v1/admin/sessions/1/messages?beforeMessageId=5',
    })).body);
    expect(older.data.messages).toHaveLength(1);
    expect(older.data.messages[0].id).toBe(10);
    await fastify.close();
  });

  it('admin message attachment endpoint streams image bytes and rejects bad index', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const sessionService = {
      getMessageAttachment: vi.fn(async () => ({ mime: 'image/png', bytes })),
    } as unknown as SessionService;
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as never,
      agentLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), requireDefaultAgent: vi.fn(), listOptions: vi.fn(async () => []) } as never,
      modelLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), findDefault: vi.fn(async () => null) } as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
    });

    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/1/messages/42/attachments/0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(vi.mocked(sessionService.getMessageAttachment)).toHaveBeenCalledWith(1, 42, 0);

    const bad = await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/1/messages/42/attachments/-1' });
    expect(JSON.parse(bad.body).code).not.toBe(0);
    expect(vi.mocked(sessionService.getMessageAttachment)).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('admin messages 在 compact=true 时启用紧凑投影', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({ messages: [], hasMore: false, nextBeforeMessageId: null })),
      getFileChangeSummariesByMessageIds: vi.fn(async () => new Map()),
      getFileChangesByMessageIds: vi.fn(async () => new Map()),
    } as unknown as SessionService;
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as never,
      agentLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), requireDefaultAgent: vi.fn(), listOptions: vi.fn(async () => []) } as never,
      modelLookup: { findById: vi.fn(), findByIds: vi.fn(async () => []), findDefault: vi.fn(async () => null) } as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
    });

    await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/1/messages?compact=true' });
    expect(vi.mocked(sessionService.getMessagesByRounds)).toHaveBeenLastCalledWith(1, 5, null, { compactMedia: true });

    await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/1/messages' });
    expect(vi.mocked(sessionService.getMessagesByRounds)).toHaveBeenLastCalledWith(1, 5, null, { compactMedia: false });
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

  it('creates session with embed source and rejects invalid source', async () => {
    const { fastify, sessionService } = await app();
    const created = JSON.parse((await fastify.inject({
      method: 'POST', url: '/v1/sessions', payload: { title: 't', agentId: 9, source: 'embed' },
    })).body);
    expect(created.code).toBe(0);
    expect(created.data.source).toBe('web'); // mock 返回默认 session()，真实落库在 service 层测
    const args = vi.mocked(sessionService.createSession).mock.calls[0];
    expect(args[args.length - 1]).toBe('embed');
    const bad = JSON.parse((await fastify.inject({
      method: 'POST', url: '/v1/sessions', payload: { title: 't', source: 'mobile' },
    })).body);
    expect(bad.code).toBe(2001);
    await fastify.close();
  });

  it('accepts cloud workspace under own root and rejects foreign channel workspaces', async () => {
    // N-5 回归：CLOUD 会话工作区会以 rw 挂进该用户的 docker 容器，用户自建会话只能
    // 指定本人每用户根之下的目录；他人通道工作区（如飞书私聊 private-8）必须被拒
    const { fastify, sessionService, root } = await app();
    mkdirSync(join(root, '7', 'projects', 'demo'), { recursive: true });
    mkdirSync(join(root, 'feishu-chat', 'bot-1', 'private-8'), { recursive: true });
    const own = JSON.parse((await fastify.inject({
      method: 'POST', url: '/v1/sessions', payload: { title: 't', agentId: 9, workspace: join(root, '7', 'projects', 'demo') },
    })).body);
    expect(own.code).toBe(0);
    expect(vi.mocked(sessionService.createSession).mock.calls[0][4]).toBe(join(root, '7', 'projects', 'demo'));

    const foreign = JSON.parse((await fastify.inject({
      method: 'POST', url: '/v1/sessions', payload: { title: 't', agentId: 9, workspace: join(root, 'feishu-chat', 'bot-1', 'private-8') },
    })).body);
    expect(foreign.code).toBe(2001);
    // 越界工作区不得进入 service 层（mock 的调用次数不增加）
    expect(vi.mocked(sessionService.createSession).mock.calls).toHaveLength(1);

    // LOCAL 模式的工作区是宿主机本机项目目录，不做每用户根校验
    const local = JSON.parse((await fastify.inject({
      method: 'POST', url: '/v1/sessions', payload: { title: 't', agentId: 9, executionMode: 'LOCAL', workspace: '/Users/someone/project' },
    })).body);
    expect(local.code).toBe(0);
    expect(vi.mocked(sessionService.createSession).mock.calls[1][4]).toBe('/Users/someone/project');
    await fastify.close();
  });

  it('lists embed sessions via source/agentId filter with pagination', async () => {
    const { fastify, sessionService } = await app();
    const res = JSON.parse((await fastify.inject({
      method: 'GET', url: '/v1/sessions?source=embed&agentId=9&offset=20&limit=30',
    })).body);
    expect(res.code).toBe(0);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].source).toBe('embed');
    expect(res.data.total).toBe(1);
    expect(res.data.hasMore).toBe(false);
    expect(vi.mocked(sessionService.listSessionsByFilter).mock.calls[0]).toEqual([7, 9, 'embed', 20, 30]);
    await fastify.close();
  });

  it('rejects list without valid source when filter params present', async () => {
    const { fastify } = await app();
    const bad = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/sessions?source=mobile' })).body);
    expect(bad.code).toBe(2001);
    const missing = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/sessions?agentId=9' })).body);
    expect(missing.code).toBe(2001);
    const badAgent = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/sessions?source=embed&agentId=abc' })).body);
    expect(badAgent.code).toBe(2001);
    await fastify.close();
  });

  it('keeps legacy list behavior when no filter params present', async () => {
    const { fastify, sessionService } = await app();
    const res = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/sessions' })).body);
    expect(res.code).toBe(0);
    expect(Array.isArray(res.data)).toBe(true);
    expect(vi.mocked(sessionService.listSessionsByFilter)).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('marks session source lazily for embed takeover', async () => {
    const { fastify, sessionService } = await app();
    const ok = JSON.parse((await fastify.inject({
      method: 'PUT', url: '/v1/sessions/1/source', payload: { source: 'embed' },
    })).body);
    expect(ok.code).toBe(0);
    expect(ok.data.source).toBe('embed');
    expect(vi.mocked(sessionService.markSessionSource)).toHaveBeenCalledWith(1, 7, 'embed');
    const bad = JSON.parse((await fastify.inject({
      method: 'PUT', url: '/v1/sessions/1/source', payload: { source: 'mobile' },
    })).body);
    expect(bad.code).toBe(2001);
    const missing = JSON.parse((await fastify.inject({
      method: 'PUT', url: '/v1/sessions/1/source', payload: {},
    })).body);
    expect(missing.code).toBe(2001);
    await fastify.close();
  });

  it('supports admin session delete and archive operations', async () => {
    const { fastify, sessionService } = await app();
    expect((await fastify.inject({ method: 'DELETE', url: '/v1/admin/sessions/1' })).statusCode).toBe(200);
    expect(vi.mocked(sessionService.deleteSession)).toHaveBeenCalledWith(1);
    expect((await fastify.inject({ method: 'PUT', url: '/v1/admin/sessions/1/archive' })).statusCode).toBe(200);
    expect(vi.mocked(sessionService.archiveSession)).toHaveBeenCalledWith(1);
    await fastify.close();
  });

  it('rejects admin session operations without admin permission', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      deleteSession: vi.fn(),
      archiveSession: vi.fn(),
    } as unknown as SessionService;
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as unknown as UserLookup,
      agentLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as unknown as AgentLookup,
      modelLookup: { findByIds: vi.fn(async () => []) } as unknown as LlmModelLookup,
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const deleted = JSON.parse((await fastify.inject({ method: 'DELETE', url: '/v1/admin/sessions/1' })).body);
    expect(deleted.code).toBe(1002);
    const archived = JSON.parse((await fastify.inject({ method: 'PUT', url: '/v1/admin/sessions/1/archive' })).body);
    expect(archived.code).toBe(1002);
    expect(vi.mocked(sessionService.deleteSession)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionService.archiveSession)).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('lets session:read list sessions but rejects archive and delete', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      listSessionsForAdmin: vi.fn(async () => ({ records: [session()], total: 1, current: 1, size: 20 })),
      getSession: vi.fn(async () => session()),
      deleteSession: vi.fn(),
      archiveSession: vi.fn(),
    } as unknown as SessionService;
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => [{ id: 7, username: 'u', displayName: 'User' }]), listOptions: vi.fn(async () => []) } as unknown as UserLookup,
      agentLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => []) } as unknown as AgentLookup,
      modelLookup: { findByIds: vi.fn(async () => []), findDefault: vi.fn(async () => null) } as unknown as LlmModelLookup,
      permissionService: { hasPermission: vi.fn(async (_userId: number, code: string) => code === 'session:read') },
    });
    const listed = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/admin/sessions' })).body);
    expect(listed.code).toBe(0);
    expect(listed.data.total).toBe(1);
    const deleted = JSON.parse((await fastify.inject({ method: 'DELETE', url: '/v1/admin/sessions/1' })).body);
    expect(deleted.code).toBe(1002);
    const archived = JSON.parse((await fastify.inject({ method: 'PUT', url: '/v1/admin/sessions/1/archive' })).body);
    expect(archived.code).toBe(1002);
    expect(vi.mocked(sessionService.deleteSession)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionService.archiveSession)).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('lets scheduled-task:read load filter options without opening the session list', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessionService = {
      listSessionsForAdmin: vi.fn(async () => ({ records: [], total: 0, current: 1, size: 20 })),
    } as unknown as SessionService;
    registerAdminSessionRoutes(fastify, {
      sessionService,
      userLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => [{ id: 7, username: 'u', displayName: 'User' }]) } as unknown as UserLookup,
      agentLookup: { findByIds: vi.fn(async () => []), listOptions: vi.fn(async () => [{ id: 9, name: 'Agent' }]) } as unknown as AgentLookup,
      modelLookup: { findByIds: vi.fn(async () => []), findDefault: vi.fn(async () => null) } as unknown as LlmModelLookup,
      permissionService: { hasPermission: vi.fn(async (_userId: number, code: string) => code === 'scheduled-task:read') },
    });
    const users = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/options/users' })).body);
    const agents = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/admin/sessions/options/agents' })).body);
    expect(users.code).toBe(0);
    expect(users.data[0].username).toBe('u');
    expect(agents.code).toBe(0);
    expect(agents.data[0].name).toBe('Agent');
    const listed = JSON.parse((await fastify.inject({ method: 'GET', url: '/v1/admin/sessions' })).body);
    expect(listed.code).toBe(1002);
    expect(vi.mocked(sessionService.listSessionsForAdmin)).not.toHaveBeenCalled();
    await fastify.close();
  });

  // 消息详情端点（技术方案 2026-10-25-run-trace-content-and-prompt §5.4）：
  // 主键直查，非法参数走空态 VO（200）；归属复用 requireSessionOwner。
  it('GET /trace/records/message/:messageId 透传正整数 messageId；非正整数走空态（service 收到 0）', async () => {
    const { fastify, runTraceRecordService } = await app();
    const ok = await fastify.inject({ method: 'GET', url: '/v1/sessions/1/trace/records/message/55' });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).code).toBe(0);
    expect(JSON.parse(ok.body).data.messageId).toBe(55);
    expect(runTraceRecordService.buildMessageRecord).toHaveBeenCalledWith(1, 55);

    for (const bad of ['0', '-5', 'abc', '1.5']) {
      vi.mocked(runTraceRecordService.buildMessageRecord).mockClear();
      const res = await fastify.inject({ method: 'GET', url: `/v1/sessions/1/trace/records/message/${bad}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).code).toBe(0);
      expect(runTraceRecordService.buildMessageRecord).toHaveBeenCalledWith(1, 0);
    }

    await fastify.close();
  });
});
