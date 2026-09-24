import type { FastifyInstance } from 'fastify';
import { requireAnyRequestPermission, requireRequestPermission, sendOk } from '../common/http-error.js';
import { collectEntityIds, parseEntityId, pathId, queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { SessionService } from './session.service.js';
import type { AgentLookup, AgentRef, AskUserQuestionsRegistry, LlmModelLookup, Session, UserLookup } from './types.js';
import { emptyQuestionRegistry } from './types.js';
import { compactAdminTranscript } from './admin-message-compact.js';
import { toAdminSessionVO, toMessageVOList, toPendingAskUserQuestionsMessageVOs } from './session-vo.js';

export interface AdminSessionRouteDeps {
  sessionService: SessionService;
  userLookup: UserLookup;
  agentLookup: AgentLookup;
  modelLookup: LlmModelLookup;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  askUserQuestionsRegistry?: AskUserQuestionsRegistry;
}

export function registerAdminSessionRoutes(app: FastifyInstance, deps: AdminSessionRouteDeps): void {
  const { sessionService, userLookup, agentLookup, modelLookup, permissionService } = deps;
  const questionRegistry = deps.askUserQuestionsRegistry ?? emptyQuestionRegistry();
  const requireRead = (request: Parameters<typeof requireRequestPermission>[1]) =>
    requireRequestPermission(permissionService, request, 'session:read');
  const requireWrite = (request: Parameters<typeof requireRequestPermission>[1]) =>
    requireRequestPermission(permissionService, request, 'session:write');
  // 用户/Agent 下拉被会话、定时任务、调用流水、审计共用，只认 session:read 会让其他页面筛选器为空。
  const requireUserOptions = (request: Parameters<typeof requireAnyRequestPermission>[1]) =>
    requireAnyRequestPermission(permissionService, request, ['session:read', 'scheduled-task:read', 'llm-call:read', 'audit:read']);
  const requireAgentOptions = (request: Parameters<typeof requireAnyRequestPermission>[1]) =>
    requireAnyRequestPermission(permissionService, request, ['session:read', 'scheduled-task:read', 'llm-call:read']);

  async function batchLoadUsers(sessions: Session[]) {
    const ids = collectEntityIds(sessions.map((s) => s.userId));
    if (ids.length === 0) return new Map<number, Awaited<ReturnType<UserLookup['findByIds']>>[number]>();
    const users = await userLookup.findByIds(ids);
    return new Map(users.map((u) => [parseEntityId(u.id) ?? u.id, u]));
  }

  async function batchLoadAgents(sessions: Session[]) {
    const ids = collectEntityIds(sessions.map((s) => s.agentId));
    if (ids.length === 0) return new Map<number, AgentRef>();
    const agents = await agentLookup.findByIds(ids);
    return new Map(agents.map((a) => [parseEntityId(a.id) ?? a.id, a]));
  }

  async function batchLoadModels(sessions: Session[], agentMap: Map<number, AgentRef>) {
    const map = new Map<number, NonNullable<Awaited<ReturnType<LlmModelLookup['findById']>>>>();
    // 会话显式模型 + Agent 默认模型一并加载（VO 展示回退链需要）
    const agentModelIds = [...agentMap.values()]
      .map((a) => a.defaultModelId)
      .filter((id): id is number => id != null);
    const ids = collectEntityIds([...sessions.map((s) => s.modelId), ...agentModelIds]);
    if (ids.length > 0) {
      for (const m of await modelLookup.findByIds(ids)) map.set(parseEntityId(m.id) ?? m.id, m);
    }
    const defaultModel = await modelLookup.findDefault();
    if (defaultModel != null) map.set(0, defaultModel);
    return map;
  }

  /** 等待用户回答（ask_user_questions）的会话计数：内存态，phase 仍为 RUNNING，需单独透出给管理端展示。 */
  function countPendingQuestions(sessions: Session[]): Map<number, number> {
    return questionRegistry.countPendingBySessionIds(collectEntityIds(sessions.map((s) => s.id)));
  }

  app.get('/v1/admin/sessions/options/users', async (request, reply) => {
    await requireUserOptions(request);
    const users = await userLookup.listOptions();
    return sendOk(reply, users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
    })));
  });

  app.get('/v1/admin/sessions/options/agents', async (request, reply) => {
    await requireAgentOptions(request);
    const agents = await agentLookup.listOptions();
    return sendOk(reply, agents.map((a) => ({ id: a.id, name: a.name })));
  });

  app.get('/v1/admin/sessions', async (request, reply) => {
    await requireRead(request);
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const pageResult = await sessionService.listSessionsForAdmin(
      page,
      size,
      queryOptInt(request, 'userId'),
      queryOptInt(request, 'agentId'),
      queryOptStr(request, 'executionMode'),
      queryOptStr(request, 'phase'),
      queryOptStr(request, 'keyword'),
      queryOptStr(request, 'status'),
    );
    const records = pageResult.records;
    const userMap = await batchLoadUsers(records);
    const agentMap = await batchLoadAgents(records);
    const modelMap = await batchLoadModels(records, agentMap);
    const voList = records.map((s) => toAdminSessionVO(
      s,
      userMap,
      agentMap,
      modelMap,
      s.id != null ? pageResult.matchSnippets?.[s.id] : undefined,
    ));
    const questionCounts = countPendingQuestions(records);
    for (const vo of voList) {
      vo.pendingQuestionCount = questionCounts.get(vo.id!) ?? 0;
    }
    return sendOk(reply, {
      records: voList,
      total: pageResult.total,
      page: pageResult.current,
      size: pageResult.size,
    });
  });

  app.get('/v1/admin/sessions/:id', async (request, reply) => {
    await requireRead(request);
    const session = await sessionService.getSession(pathId(request));
    const single = [session];
    const agentMap = await batchLoadAgents(single);
    const vo = toAdminSessionVO(
      session,
      await batchLoadUsers(single),
      agentMap,
      await batchLoadModels(single, agentMap),
    );
    vo.pendingQuestionCount = countPendingQuestions(single).get(parseEntityId(session.id) ?? 0) ?? 0;
    return sendOk(reply, vo);
  });

  app.get('/v1/admin/sessions/:id/messages', async (request, reply) => {
    await requireRead(request);
    const id = pathId(request);
    const roundLimit = queryOptInt(request, 'roundLimit') ?? 5;
    const beforeMessageId = queryOptInt(request, 'beforeMessageId') ?? null;
    const page = await sessionService.getMessagesByRounds(id, roundLimit, beforeMessageId);
    const messageIds = page.messages.map((m) => m.id!);
    // compact：详情页不展示 diff，工具卡片也只画出截断后的输出。导出仍走完整载荷。
    const compact = queryOptBool(request, 'compact') === true;
    const changesByMsg = compact
      ? await sessionService.getFileChangeSummariesByMessageIds(id, messageIds)
      : await sessionService.getFileChangesByMessageIds(id, messageIds);
    const messages = compact ? compactAdminTranscript(page.messages) : page.messages;
    const vos = toMessageVOList(messages, changesByMsg);
    // 等待回复中的 ask_user_questions 尚未随整轮落库，从内存注册表补进行中卡片（仅最新一页）
    if (beforeMessageId == null) {
      vos.push(...toPendingAskUserQuestionsMessageVOs(questionRegistry.getPendingForSession(id)));
    }
    return sendOk(reply, {
      messages: vos,
      hasMore: page.hasMore,
      nextBeforeMessageId: page.nextBeforeMessageId,
    });
  });

  app.delete('/v1/admin/sessions/:id', async (request, reply) => {
    await requireWrite(request);
    await sessionService.deleteSession(pathId(request));
    return sendOk(reply);
  });

  app.put('/v1/admin/sessions/:id/archive', async (request, reply) => {
    await requireWrite(request);
    await sessionService.archiveSession(pathId(request));
    return sendOk(reply);
  });
}
