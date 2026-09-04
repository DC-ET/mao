import type { FastifyInstance } from 'fastify';
import { requireAdmin, sendOk } from '../common/http-error.js';
import { collectEntityIds, parseEntityId, pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import type { SessionService } from './session.service.js';
import type { AgentLookup, AgentRef, LlmModelLookup, Session, UserLookup } from './types.js';
import { toAdminSessionVO, toMessageVOList } from './session-vo.js';

export interface AdminSessionRouteDeps {
  sessionService: SessionService;
  userLookup: UserLookup;
  agentLookup: AgentLookup;
  modelLookup: LlmModelLookup;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
}

export function registerAdminSessionRoutes(app: FastifyInstance, deps: AdminSessionRouteDeps): void {
  const { sessionService, userLookup, agentLookup, modelLookup, permissionService } = deps;
  const requireAdminUser = (request: Parameters<typeof requireAdmin>[1]) => requireAdmin(permissionService, request);

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

  app.get('/v1/admin/sessions/options/users', async (request, reply) => {
    await requireAdminUser(request);
    const users = await userLookup.listOptions();
    return sendOk(reply, users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
    })));
  });

  app.get('/v1/admin/sessions/options/agents', async (request, reply) => {
    await requireAdminUser(request);
    const agents = await agentLookup.listOptions();
    return sendOk(reply, agents.map((a) => ({ id: a.id, name: a.name })));
  });

  app.get('/v1/admin/sessions', async (request, reply) => {
    await requireAdminUser(request);
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
    const voList = records.map((s) => toAdminSessionVO(s, userMap, agentMap, modelMap));
    return sendOk(reply, {
      records: voList,
      total: pageResult.total,
      page: pageResult.current,
      size: pageResult.size,
    });
  });

  app.get('/v1/admin/sessions/:id', async (request, reply) => {
    await requireAdminUser(request);
    const session = await sessionService.getSession(pathId(request));
    const single = [session];
    const agentMap = await batchLoadAgents(single);
    return sendOk(reply, toAdminSessionVO(
      session,
      await batchLoadUsers(single),
      agentMap,
      await batchLoadModels(single, agentMap),
    ));
  });

  app.get('/v1/admin/sessions/:id/messages', async (request, reply) => {
    await requireAdminUser(request);
    const id = pathId(request);
    const roundLimit = queryOptInt(request, 'roundLimit') ?? 5;
    const beforeMessageId = queryOptInt(request, 'beforeMessageId') ?? null;
    const page = await sessionService.getMessagesByRounds(id, roundLimit, beforeMessageId);
    const changesByMsg = await sessionService.getFileChangesByMessageIds(id, page.messages.map((m) => m.id!));
    return sendOk(reply, {
      messages: toMessageVOList(page.messages, changesByMsg),
      hasMore: page.hasMore,
      nextBeforeMessageId: page.nextBeforeMessageId,
    });
  });
}
