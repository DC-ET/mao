import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, collectEntityIds, idMapGet, parseEntityId, pathId, queryOptInt, queryOptStr } from '../common/request.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { SessionService } from './session.service.js';
import type { ActivityService } from './activity.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';
import type { SessionTodoRepository, SubagentExecutionRepository } from './activity.repository.js';
import type {
  AgentLookup,
  ApprovalRegistry,
  AskUserQuestionsRegistry,
  LlmModelLookup,
  Session,
  SessionTreeSignalPublisher,
} from './types.js';
import { emptyApprovalRegistry, emptyQuestionRegistry, noopTreePublisher } from './types.js';
import {
  applySessionListSignals,
  indexSubagentExecutions,
  toActivityVO,
  toCompactionEventVO,
  toMessageVO,
  toMessageVOList,
  toQueueMessageVO,
  toSessionVO,
  toTodoVO,
  type SessionVO,
} from './session-vo.js';

export interface SessionRouteDeps {
  sessionService: SessionService;
  agentLookup: AgentLookup;
  modelLookup: LlmModelLookup;
  activityService: ActivityService;
  todoRepo: SessionTodoRepository;
  messageQueueService: MessageQueueService;
  pathSandbox: PathSandbox;
  subagentExecutionRepo: SubagentExecutionRepository;
  sessionCompactionEventService: SessionCompactionEventService;
  approvalRegistry?: ApprovalRegistry;
  askUserQuestionsRegistry?: AskUserQuestionsRegistry;
  treeSignalPublisher?: SessionTreeSignalPublisher;
}

interface CreateSessionRequest {
  agentId?: number | null;
  title?: string | null;
  executionMode?: string | null;
  workspace?: string | null;
  cloudProjectKey?: string | null;
  workspaceMode?: string | null;
  gitCloneUrl?: string | null;
  gitBranch?: string | null;
  permissionLevel?: string | null;
  modelId?: number | null;
  isGit?: boolean | null;
  platform?: string | null;
  shell?: string | null;
  osVersion?: string | null;
}

interface UpdateSessionRequest {
  title?: string | null;
  summary?: string | null;
  projectKey?: string | null;
  permissionLevel?: string | null;
  modelId?: number | null;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const approvalRegistry = deps.approvalRegistry ?? emptyApprovalRegistry();
  const questionRegistry = deps.askUserQuestionsRegistry ?? emptyQuestionRegistry();
  const treeSignalPublisher = deps.treeSignalPublisher ?? noopTreePublisher();
  const { sessionService, agentLookup, modelLookup } = deps;

  async function requireSessionOwner(userId: number, sessionId: number): Promise<Session> {
    const session = await sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该会话');
    }
    return session;
  }

  async function batchLoadAgents(sessions: Session[]): Promise<Map<number, { id: number; name: string }>> {
    const ids = collectEntityIds(sessions.map((s) => s.agentId));
    if (ids.length === 0) return new Map();
    const agents = await agentLookup.findByIds(ids);
    return new Map(agents.map((a) => [parseEntityId(a.id) ?? a.id, a]));
  }

  async function batchLoadModels(sessions: Session[]): Promise<Map<number, Awaited<ReturnType<LlmModelLookup['findById']>> & object>> {
    const map = new Map<number, NonNullable<Awaited<ReturnType<LlmModelLookup['findById']>>>>();
    const ids = collectEntityIds(sessions.map((s) => s.modelId));
    if (ids.length > 0) {
      const models = await modelLookup.findByIds(ids);
      for (const m of models) map.set(parseEntityId(m.id) ?? m.id, m);
    }
    const defaultModel = await modelLookup.findDefault();
    if (defaultModel != null) {
      map.set(0, defaultModel);
    }
    return map;
  }

  async function enrichSessions(sessions: Session[]): Promise<SessionVO[]> {
    const agentMap = await batchLoadAgents(sessions);
    const modelMap = await batchLoadModels(sessions);
    const vos = sessions.map((s) => toSessionVO(s, agentMap, modelMap));
    const mainIds = sessions.map((s) => s.id!).filter((id) => id != null);
    const sides = await sessionService.listSideTasksByParentIds(mainIds);
    const sidesByParent = new Map<number, Session[]>();
    for (const st of sides) {
      if (st.parentSessionId == null) continue;
      const list = sidesByParent.get(st.parentSessionId) ?? [];
      list.push(st);
      sidesByParent.set(st.parentSessionId, list);
    }
    applySessionListSignals(sessions, vos, sidesByParent, approvalRegistry, questionRegistry);
    return vos;
  }

  app.post('/v1/sessions', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<CreateSessionRequest>(request);
    const session = await sessionService.createSession(
      userId, parseEntityId(body.agentId), body.title, body.executionMode, body.workspace,
      body.permissionLevel, body.isGit, body.platform, body.shell, body.osVersion,
      parseEntityId(body.modelId), body.cloudProjectKey, body.workspaceMode, body.gitCloneUrl, body.gitBranch,
    );
    const vos = await enrichSessions([session]);
    return sendOk(reply, vos[0]);
  });

  app.get('/v1/sessions/cloud-projects', async (request, reply) => {
    const userId = requireUserId(request);
    const userRoot = resolve(deps.pathSandbox.getWorkspaceRoot(), String(userId));
    const projectsDir = join(userRoot, 'projects');
    const projects: Array<{ name: string; path: string; isGit: boolean }> = [];
    if (existsSync(projectsDir)) {
      try {
        for (const name of readdirSync(projectsDir)) {
          const dir = join(projectsDir, name);
          if (!statSync(dir).isDirectory()) continue;
          projects.push({
            name,
            path: dir,
            isGit: existsSync(join(dir, '.git')),
          });
        }
        projects.sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) {
        console.warn(`Failed to list cloud projects for user ${userId}: ${(e as Error).message}`);
      }
    }
    return sendOk(reply, projects);
  });

  app.get('/v1/sessions/groups', async (request, reply) => {
    const userId = requireUserId(request);
    const keyword = queryOptStr(request, 'keyword');
    const status = queryOptStr(request, 'status');
    const previewLimit = queryOptInt(request, 'previewLimit') ?? 5;
    const buckets = await sessionService.listSessionGroups(userId, keyword, status, previewLimit);
    const previewSessions = buckets.flatMap((b) => b.sessions);
    const previewVos = await enrichSessions(previewSessions);
    const voById = new Map<number, SessionVO>();
    for (let i = 0; i < previewSessions.length; i++) {
      voById.set(previewSessions[i].id!, previewVos[i]);
    }
    return sendOk(reply, {
      groups: buckets.map((b) => ({
        key: b.key,
        label: b.label,
        total: b.total,
        hasMore: b.hasMore,
        sessions: b.sessions.map((s) => voById.get(s.id!)),
      })),
    });
  });

  app.get('/v1/sessions/search', async (request, reply) => {
    const userId = requireUserId(request);
    const keyword = queryOptStr(request, 'keyword') ?? '';
    const items = await sessionService.searchSessionsByUserMessage(userId, keyword);
    return sendOk(reply, { items });
  });

  app.get('/v1/sessions/dashboard', async (request, reply) => {
    const userId = requireUserId(request);
    const grouped = await sessionService.listSessionsForDashboard(userId);
    const runningSessions = grouped.running ?? [];
    const recentSessions = grouped.recent ?? [];
    const runningVos = await enrichSessions(runningSessions);
    const recentVos = await enrichSessions(recentSessions);
    return sendOk(reply, { running: runningVos, recent: recentVos });
  });

  app.get('/v1/sessions', async (request, reply) => {
    const userId = requireUserId(request);
    const groupKey = queryOptStr(request, 'groupKey');
    const keyword = queryOptStr(request, 'keyword');
    const status = queryOptStr(request, 'status');
    if (groupKey != null && groupKey.trim().length > 0) {
      const offset = queryOptInt(request, 'offset') ?? 0;
      const limit = queryOptInt(request, 'limit') ?? 20;
      const page = await sessionService.listSessionsByGroup(userId, groupKey, keyword, status, offset, limit);
      const items = await enrichSessions(page.items);
      return sendOk(reply, {
        items,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
      });
    }
    const sessions = await sessionService.listSessions(userId, keyword, status);
    return sendOk(reply, await enrichSessions(sessions));
  });

  app.get('/v1/sessions/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireSessionOwner(userId, pathId(request));
    const vos = await enrichSessions([session]);
    return sendOk(reply, vos[0]);
  });

  app.delete('/v1/sessions/:id', async (request, reply) => {
    const userId = requireUserId(request);
    await requireSessionOwner(userId, pathId(request));
    await sessionService.deleteSession(pathId(request));
    return sendOk(reply);
  });

  app.put('/v1/sessions/:id/pin', async (request, reply) => {
    const userId = requireUserId(request);
    await requireSessionOwner(userId, pathId(request));
    await sessionService.togglePin(pathId(request));
    return sendOk(reply);
  });

  app.put('/v1/sessions/:id/favorite', async (request, reply) => {
    const userId = requireUserId(request);
    await requireSessionOwner(userId, pathId(request));
    await sessionService.toggleFavorite(pathId(request));
    return sendOk(reply);
  });

  app.put('/v1/sessions/:id/archive', async (request, reply) => {
    const userId = requireUserId(request);
    await requireSessionOwner(userId, pathId(request));
    await sessionService.archiveSession(pathId(request));
    return sendOk(reply);
  });

  app.put('/v1/sessions/:id/unarchive', async (request, reply) => {
    const userId = requireUserId(request);
    await requireSessionOwner(userId, pathId(request));
    await sessionService.unarchiveSession(pathId(request));
    return sendOk(reply);
  });

  app.put('/v1/sessions/:id/read', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    await sessionService.markAsRead(id);
    const s = await sessionService.getSession(id);
    if (s.sessionType === 'SIDE_TASK' && s.parentSessionId != null) {
      treeSignalPublisher.publish(s.parentSessionId);
    } else {
      treeSignalPublisher.publish(id);
    }
    return sendOk(reply);
  });

  app.patch('/v1/sessions/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const body = bodyOf<UpdateSessionRequest>(request);
    if (body.title != null) await sessionService.updateTitle(id, body.title);
    if (body.summary != null) await sessionService.updateSummary(id, body.summary);
    if (body.projectKey != null) await sessionService.updateProjectKey(id, body.projectKey);
    if (body.permissionLevel != null) await sessionService.updatePermissionLevel(id, body.permissionLevel);
    const modelId = parseEntityId(body.modelId);
    if (modelId != null) await sessionService.updateModelId(id, modelId);
    const updated = await sessionService.getSession(id);
    const vos = await enrichSessions([updated]);
    return sendOk(reply, vos[0]);
  });

  app.get('/v1/sessions/:id/side-tasks', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const sideTasks = await sessionService.listSideTaskSessions(id, userId);
    const sideIds = sideTasks.map((s) => s.id!);
    const approvalCounts = approvalRegistry.countForSessionIds(sideIds);
    const questionCounts = questionRegistry.countPendingBySessionIds(sideIds);
    return sendOk(reply, sideTasks.map((s) => ({
      id: s.id,
      title: s.title,
      modelId: s.modelId,
      phase: s.phase != null ? s.phase : 'IDLE',
      createdAt: javaLocalDateTimeString(s.createdAt),
      updatedAt: javaLocalDateTimeString(s.updatedAt),
      startedAt: javaLocalDateTimeString(s.startedAt),
      unread: s.unread === 1,
      pendingApprovalCount: approvalCounts.get(s.id!) ?? 0,
      pendingQuestionCount: questionCounts.get(s.id!) ?? 0,
    })));
  });

  app.get('/v1/sessions/:id/subagents', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const subagents = await sessionService.listSubagentSessionsWithSideTasks(id, userId);
    const executions = await deps.subagentExecutionRepo.findByChildSessionIds(subagents.map((s) => s.id!));
    const executionByChild = indexSubagentExecutions(executions);
    return sendOk(reply, subagents.map((s) => {
      const exec = executionByChild.get(s.id!);
      let phase = s.phase != null ? s.phase : 'IDLE';
      if (exec?.status != null && (s.phase == null || s.phase.length === 0 || s.phase === 'IDLE')) {
        phase = exec.status;
      }
      return {
        id: s.id,
        title: s.title,
        phase,
        createdAt: javaLocalDateTimeString(s.createdAt),
        agentType: exec?.agentType,
        taskDescription: exec?.taskDescription,
      };
    }));
  });

  app.get('/v1/sessions/:id/messages', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const roundLimit = queryOptInt(request, 'roundLimit') ?? 5;
    const beforeMessageId = queryOptInt(request, 'beforeMessageId') ?? null;
    const page = await sessionService.getMessagesByRounds(id, roundLimit, beforeMessageId);
    const changesByMsg = await sessionService.getFileChangesByMessageIds(id, page.messages.map((m) => m.id!));
    const vo: {
      messages: ReturnType<typeof toMessageVOList>;
      hasMore: boolean;
      nextBeforeMessageId: number | null;
      compactionEvents?: ReturnType<typeof toCompactionEventVO>[];
    } = {
      messages: toMessageVOList(page.messages, changesByMsg),
      hasMore: page.hasMore,
      nextBeforeMessageId: page.nextBeforeMessageId,
    };
    if (beforeMessageId == null) {
      vo.compactionEvents = (await deps.sessionCompactionEventService.listBySessionId(id)).map(toCompactionEventVO);
    }
    return sendOk(reply, vo);
  });

  app.patch('/v1/sessions/:sessionId/messages/:messageId', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sessionId');
    await requireSessionOwner(userId, sessionId);
    const body = bodyOf<{ content?: string | null; images?: string[] | null }>(request);
    const edited = await sessionService.editMessageAndTruncate(
      pathId(request, 'messageId'), body.content ?? null, body.images ?? null,
    );
    return sendOk(reply, toMessageVO(edited));
  });

  app.get('/v1/sessions/:id/activities', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const limit = queryOptInt(request, 'limit') ?? 50;
    const activities = await deps.activityService.listBySession(id, limit);
    return sendOk(reply, activities.map(toActivityVO));
  });

  app.get('/v1/sessions/:id/todos', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const todos = await deps.todoRepo.listBySession(id);
    return sendOk(reply, todos.map(toTodoVO));
  });

  app.patch('/v1/sessions/:sessionId/todos/:todoId', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sessionId');
    await requireSessionOwner(userId, sessionId);
    const todoId = pathId(request, 'todoId');
    const body = bodyOf<{ status?: string | null; content?: string | null }>(request);
    if (body.status === 'in_progress') {
      await deps.todoRepo.resetInProgressExcept(sessionId, todoId);
    }
    const fields: Record<string, unknown> = {};
    if (body.status != null) fields.status = body.status;
    if (body.content != null) fields.content = body.content;
    await deps.todoRepo.updateFields(todoId, sessionId, fields);
    return sendOk(reply);
  });

  app.delete('/v1/sessions/:sessionId/todos/:todoId', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sessionId');
    await requireSessionOwner(userId, sessionId);
    await deps.todoRepo.logicalDelete(pathId(request, 'todoId'), sessionId);
    return sendOk(reply);
  });

  app.get('/v1/sessions/:id/queue', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const queue = await deps.messageQueueService.listPending(id);
    return sendOk(reply, queue.map(toQueueMessageVO));
  });
}
