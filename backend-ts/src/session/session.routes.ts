import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, collectEntityIds, idMapGet, parseEntityId, pathId, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import { isSessionSource, type SessionSource } from './session.repository.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { SessionService } from './session.service.js';
import type { ActivityService } from './activity.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { RunTraceService } from './run-trace.service.js';
import type { SessionTodoRepository, SubagentExecutionRepository } from './activity.repository.js';
import type {
  AgentLookup,
  AgentRef,
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
  sessionCompactionService: SessionCompactionService;
  runTraceService: RunTraceService;
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
  source?: string | null;
}

interface UpdateSessionRequest {
  title?: string | null;
  summary?: string | null;
  projectKey?: string | null;
  permissionLevel?: string | null;
  memoryInjectionDisabled?: boolean | null;
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

  async function batchLoadAgents(sessions: Session[]): Promise<Map<number, AgentRef>> {
    const ids = collectEntityIds(sessions.map((s) => s.agentId));
    if (ids.length === 0) return new Map();
    const agents = await agentLookup.findByIds(ids);
    return new Map(agents.map((a) => [parseEntityId(a.id) ?? a.id, a]));
  }

  async function batchLoadModels(sessions: Session[], agentMap: Map<number, AgentRef>): Promise<Map<number, Awaited<ReturnType<LlmModelLookup['findById']>> & object>> {
    const map = new Map<number, NonNullable<Awaited<ReturnType<LlmModelLookup['findById']>>>>();
    // 会话显式模型 + Agent 默认模型一并加载（VO 展示回退链需要）
    const agentModelIds = [...agentMap.values()]
      .map((a) => a.defaultModelId)
      .filter((id): id is number => id != null);
    const ids = collectEntityIds([...sessions.map((s) => s.modelId), ...agentModelIds]);
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
    const modelMap = await batchLoadModels(sessions, agentMap);
    const vos = sessions.map((s) => toSessionVO(s, agentMap, modelMap));
    const mainIds = sessions.map((s) => s.id!).filter((id) => id != null);
    // tree* 首刷口径与 WS 信号 / recursive 列表一致：聚合并发树下的全部后代边路任务。
    // 列表 / dashboard 查询本就排除 SIDE_TASK / SUBAGENT，这里的主会话集合全部是树根。
    const descendantsByRoot = await sessionService.listDescendantSideTaskSessionsByRoots(mainIds);
    const sidesByParent = new Map<number, Session[]>();
    for (const [rootId, list] of descendantsByRoot) {
      if (list.length > 0) sidesByParent.set(rootId, list);
    }
    applySessionListSignals(sessions, vos, sidesByParent, approvalRegistry, questionRegistry);
    return vos;
  }

  app.post('/v1/sessions', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<CreateSessionRequest>(request);
    if (body.source != null && !isSessionSource(body.source)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, "source 仅允许 'web' / 'embed'");
    }
    const session = await sessionService.createSession(
      userId, parseEntityId(body.agentId), body.title, body.executionMode, body.workspace,
      body.permissionLevel, body.isGit, body.platform, body.shell, body.osVersion,
      parseEntityId(body.modelId), body.cloudProjectKey, body.workspaceMode, body.gitCloneUrl, body.gitBranch,
      body.source as SessionSource | null,
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
    const source = queryOptStr(request, 'source');
    const rawAgentId = queryOptStr(request, 'agentId');
    if (source != null || rawAgentId != null) {
      // Embed SDK 历史列表分支：仅 source / agentId 过滤 + 独立分页，不参与 groupKey/keyword/status
      if (source == null || !isSessionSource(source)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '过滤查询需提供合法的 source（web 或 embed）');
      }
      let agentId: number | null = null;
      if (rawAgentId != null) {
        const n = Number(rawAgentId);
        if (!Number.isInteger(n) || n <= 0) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, 'agentId 必须为正整数');
        }
        agentId = n;
      }
      const offset = queryOptInt(request, 'offset') ?? 0;
      const limit = queryOptInt(request, 'limit') ?? 20;
      const page = await sessionService.listSessionsByFilter(userId, agentId, source, offset, limit);
      const items = await enrichSessions(page.items);
      return sendOk(reply, {
        items,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
      });
    }
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
    const target = await requireSessionOwner(userId, pathId(request));
    await sessionService.deleteSession(target.id!);
    // 删除中间层边路任务会让后代成为孤儿（从树上不可达，其后续终态信号也会断链）：
    // 沿删除前的父链向根补发一次树信号，驱动前端刷新列表、按递归口径重算聚合（孤儿天然剔除）
    treeSignalPublisher.publishAtRoot(target.parentSessionId ?? target.id!);
    return sendOk(reply);
  });

  app.post('/v1/sessions/:id/promote-side-task', async (request, reply) => {
    const userId = requireUserId(request);
    const source = await requireSessionOwner(userId, pathId(request));
    const promoted = await sessionService.promoteSideTaskToMainSession(source.id!, userId);
    const vos = await enrichSessions([promoted]);
    if (source.parentSessionId != null) {
      // 提升后旧树（可能隔着多层边路）失去该子树：信号沿旧父链上溯到旧根，重算聚合口径
      treeSignalPublisher.publishAtRoot(source.parentSessionId);
    }
    return sendOk(reply, vos[0]);
  });

  app.put('/v1/sessions/:id/source', async (request, reply) => {
    const userId = requireUserId(request);
    await requireSessionOwner(userId, pathId(request));
    const body = bodyOf<{ source?: string | null }>(request);
    if (body.source == null || !isSessionSource(body.source)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, "source 仅允许 'web' / 'embed'");
    }
    const session = await sessionService.markSessionSource(pathId(request), userId, body.source);
    const vos = await enrichSessions([session]);
    return sendOk(reply, vos[0]);
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
      // 深层边路已读也要刷新树信号：沿父链上溯到根，唯一信号键与消费方口径一致
      treeSignalPublisher.publishAtRoot(id);
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
    if (body.memoryInjectionDisabled != null) await sessionService.updateMemoryInjectionDisabled(id, body.memoryInjectionDisabled);
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
    // recursive=1：平铺根主会话树下的全部后代边路任务（updated_at 降序）；缺省保持直接子级口径
    const sideTasks = queryOptBool(request, 'recursive') === true
      ? await sessionService.listDescendantSideTaskSessions(id, userId)
      : await sessionService.listSideTaskSessions(id, userId);
    const sideIds = sideTasks.map((s) => s.id!);
    const approvalCounts = approvalRegistry.countForSessionIds(sideIds);
    const questionCounts = questionRegistry.countPendingBySessionIds(sideIds);
    return sendOk(reply, sideTasks.map((s) => ({
      id: s.id,
      title: s.title,
      modelId: s.modelId,
      parentSessionId: s.parentSessionId,
      permissionLevel: s.permissionLevel,
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

  // 压缩摘要读取端点（技术方案 5.5）：只读 session_compaction 现值，不回填、不触发校验删除。
  // 无压缩记录时 data 为 null（不算错）。摘要继承站内脱敏视角（含 $MAO_REDACTED 即原样返回，不二次脱敏）。
  app.get('/v1/sessions/:id/compaction', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const record = await deps.sessionCompactionService.findBySessionId(id);
    if (record == null) return sendOk(reply, null);
    return sendOk(reply, {
      summaryText: record.summaryText ?? null,
      lastCompactedMsgId: record.lastCompactedMsgId ?? null,
      compactCount: record.compactCount ?? null,
      compactModel: record.compactModel ?? null,
      updatedAt: javaLocalDateTimeString(record.updatedAt),
    });
  });

  // Fork 预览：边路任务发出前预演「这条边路会话会看到哪些历史消息」。
  // 轮次分页口径与 GET /messages 完全一致（roundLimit / hasMore / nextBeforeMessageId），
  // 只把上界换成切点（forkFromMessageId = 被点击那一轮的助手最终回复；不传 = 全量分叉）。
  // 只读，不落任何状态。
  app.get('/v1/sessions/:id/fork-preview', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const roundLimit = queryOptInt(request, 'roundLimit') ?? 5;
    const cutMessageId = queryOptInt(request, 'forkFromMessageId') ?? null;
    if (cutMessageId != null && cutMessageId <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID);
    }
    if (cutMessageId != null && (await sessionService.findOwnedMessage(id, cutMessageId)) == null) {
      throw new BusinessException(ErrorCode.MESSAGE_NOT_FOUND);
    }
    const page = await sessionService.getForkPreview(id, cutMessageId, roundLimit, queryOptInt(request, 'beforeMessageId') ?? null);
    const changesByMsg = await sessionService.getFileChangesByMessageIds(id, page.messages.map((m) => m.id!));
    return sendOk(reply, {
      messages: toMessageVOList(page.messages, changesByMsg),
      hasMore: page.hasMore,
      nextBeforeMessageId: page.nextBeforeMessageId,
      compactionEvents: (await deps.sessionCompactionEventService.listBySessionId(id))
        .filter((ev) => cutMessageId == null || ev.boundaryMsgId == null || ev.boundaryMsgId <= cutMessageId)
        .map(toCompactionEventVO),
    });
  });

  app.patch('/v1/sessions/:sessionId/messages/:messageId', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sessionId');
    await requireSessionOwner(userId, sessionId);
    const body = bodyOf<{ content?: string | null; images?: string[] | null }>(request);
    const edited = await sessionService.editMessageAndTruncate(
      sessionId, pathId(request, 'messageId'), body.content ?? null, body.images ?? null,
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

  // run 轨迹（技术方案 2026-10-09-run-trace）：读时聚合，回答「这一轮到底发生了什么」。
  // run = 一条现存用户消息到下一条更新的用户消息；慢 / 贵阈值是展示参数，由 query 钳制后传入。
  app.get('/v1/sessions/:id/trace', async (request, reply) => {
    const userId = requireUserId(request);
    const id = pathId(request);
    await requireSessionOwner(userId, id);
    const limit = Math.min(queryOptInt(request, 'limit') ?? 5, 50);
    const slowMs = clamp(queryOptInt(request, 'slowMs') ?? 60_000, 1_000, 3_600_000);
    const expensiveTokens = clamp(queryOptInt(request, 'expensiveTokens') ?? 50_000, 1_000, 10_000_000);
    return sendOk(reply, await deps.runTraceService.buildTrace(id, {
      beforeRunId: queryOptInt(request, 'beforeRunId') ?? null,
      limit,
      slowMs,
      expensiveTokens,
    }));
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

/** 轨迹阈值钳制：非法 query 回落默认区间，避免越界值把整个会话都标成慢 / 贵。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
