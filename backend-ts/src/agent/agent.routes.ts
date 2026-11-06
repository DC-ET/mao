import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { normalizeAndValidateGitDomain } from '../common/git-domain.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryOptBool, queryOptStr } from '../common/request.js';
import type { UserRepository } from '../user/types.js';
import type { HttpToolValidator } from '../http-tool/types.js';
import { parseHttpToolIds } from '../http-tool/types.js';
import { experienceInputOf } from './agent-experience.service.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import { suggestedQuestionInputOf } from './agent-suggested-question.service.js';
import type { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import type { AgentService } from './agent.service.js';
import type {
  Agent,
  AgentExperience,
  AgentSuggestedQuestion,
  AgentVO,
  ExperienceInput,
  ExperienceVO,
  SuggestedQuestionInput,
  SuggestedQuestionVO,
  McpServerValidator,
} from './types.js';

export interface AgentRouteDeps {
  agentService: AgentService;
  experienceService: AgentExperienceService;
  suggestedQuestionService: AgentSuggestedQuestionService;
  userRepo: UserRepository;
  mcpServerValidator: McpServerValidator;
  httpToolValidator: HttpToolValidator;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface CreateAgentRequest {
  name?: string;
  description?: string | null;
  avatarUrl?: string | null;
  systemPrompt?: string;
  skillNames?: string[];
  mcpServerIds?: number[];
  httpToolIds?: number[];
  gitAllowedDomains?: string[] | null;
  experiences?: ExperienceVO[];
  suggestedQuestions?: SuggestedQuestionVO[];
  isDefault?: number | null;
  defaultModelId?: number | null;
  clientVisible?: boolean | null;
  experienceLibraryEnabled?: boolean | null;
}

interface UpdateAgentRequest {
  name?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  systemPrompt?: string | null;
  skillNames?: string[] | null;
  mcpServerIds?: number[] | null;
  httpToolIds?: number[] | null;
  /** 四态：undefined=不修改；null=清空；[]=显式禁止注入；非空=白名单（技术方案 2026-11-06 §3.6）。 */
  gitAllowedDomains?: string[] | null;
  experiences?: ExperienceVO[] | null;
  suggestedQuestions?: SuggestedQuestionVO[] | null;
  isDefault?: number | null;
  defaultModelId?: number | null;
  clientVisible?: boolean | null;
  experienceLibraryEnabled?: boolean | null;
}

interface ExperienceRequest {
  content?: string;
  sortOrder?: number | null;
  enabled?: boolean | null;
}

const MAX_GIT_DOMAINS = 32;
const MAX_GIT_DOMAIN_LENGTH = 253;
const MAX_GIT_DOMAINS_JSON_LENGTH = 1024;

/**
 * 校验并规范化 Git 凭据域白名单（技术方案 2026-11-06 §3.6）。
 * 四态：undefined=不修改；null=清空；[]=显式禁止注入；非空=白名单。
 * 顺序：逐项规范化/校验（保留原两条错误文案）→ 去重 → 数量/单长（友好提示）
 * → JSON 总长（最终闸门，必须最后判，防「分项都过但总长超过 VARCHAR(1024)」）。
 */
function normalizeGitDomains(input: string[] | null | undefined): string[] | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (!Array.isArray(input)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'gitAllowedDomains 必须是字符串数组或 null');
  }
  const normalized: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git 凭据域必须是字符串');
    }
    const domain = normalizeAndValidateGitDomain(raw);
    if (!normalized.includes(domain)) normalized.push(domain);
  }
  if (normalized.length > MAX_GIT_DOMAINS) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `Git 凭据域最多 ${MAX_GIT_DOMAINS} 条`);
  }
  if (normalized.some((domain) => domain.length > MAX_GIT_DOMAIN_LENGTH)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `单个域名不能超过 ${MAX_GIT_DOMAIN_LENGTH} 字符`);
  }
  if (JSON.stringify(normalized).length > MAX_GIT_DOMAINS_JSON_LENGTH) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `Git 凭据域配置总长度不能超过 ${MAX_GIT_DOMAINS_JSON_LENGTH} 字符`);
  }
  return normalized;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { agentService, experienceService, userRepo, mcpServerValidator, httpToolValidator, permissionService } = deps;

  async function requireAgentWrite(request: Parameters<typeof requireUserId>[0]): Promise<number> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    return userId;
  }

  app.get('/v1/agents', async (request, reply) => {
    const userId = requireUserId(request);
    const keyword = queryOptStr(request, 'keyword');
    const scope = queryOptStr(request, 'scope');
    if (scope != null && scope !== 'client') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, "scope 仅支持 'client'");
    }
    const wantDisabled = queryOptBool(request, 'includeDisabled') === true;
    const missingGitDomains = queryOptBool(request, 'missingGitDomains') === true;
    // 最小暴露：gitAllowedDomains 与「未配置」筛选仅对具备 Agent 管理权限的用户开放
    const canManage = await permissionService.hasPermission(userId, 'agent:read')
      || await permissionService.hasPermission(userId, 'agent:write');
    const includeDisabled = wantDisabled && canManage;
    const agents = await agentService.listAgents(
      userId, keyword, includeDisabled, scope === 'client', missingGitDomains && canManage,
    );
    const voList = await Promise.all(
      agents.map((agent) => toVO(agent, agentService, userRepo, { includeGitDomains: canManage })),
    );
    return sendOk(reply, voList);
  });

  app.get('/v1/agents/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const canManage = await permissionService.hasPermission(userId, 'agent:read')
      || await permissionService.hasPermission(userId, 'agent:write');
    const agent = await agentService.getAgent(pathId(request));
    return sendOk(reply, await toVO(agent, agentService, userRepo, { includeGitDomains: canManage }));
  });

  app.post('/v1/agents', async (request, reply) => {
    const userId = await requireAgentWrite(request);
    const body = bodyOf<CreateAgentRequest>(request);
    if (!hasText(body.name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Agent 名称不能为空');
    }
    if (!hasText(body.systemPrompt)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '角色定义不能为空');
    }
    const mcpServerIds = await resolveMcpServerIds(mcpServerValidator, body.mcpServerIds);
    const httpToolIds = await resolveHttpToolIds(httpToolValidator, body.httpToolIds);
    const gitAllowedDomains = normalizeGitDomains(body.gitAllowedDomains);
    const agent = await agentService.createAgent(
      userId,
      body.name!,
      body.description,
      body.systemPrompt!,
      body.skillNames,
      mcpServerIds,
      httpToolIds,
      toExperienceInputs(body.experiences),
      toSuggestedQuestionInputs(body.suggestedQuestions),
      body.isDefault,
      body.defaultModelId,
      body.avatarUrl,
      body.clientVisible,
      body.experienceLibraryEnabled,
      gitAllowedDomains,
    );
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.put('/v1/agents/:id', async (request, reply) => {
    const userId = await requireAgentWrite(request);
    const agentId = pathId(request);
    const body = bodyOf<UpdateAgentRequest>(request);
    const mcpServerIds = await resolveMcpServerIds(mcpServerValidator, body.mcpServerIds ?? undefined);
    // 存量关联用于容忍「工具被停用/删除后的残留 id」：这类 id 不是本次新关联，不能拒绝整次编辑。
    const existingHttpToolIds = body.httpToolIds != null
      && Array.isArray(body.httpToolIds)
      && body.httpToolIds.length > 0
      ? parseHttpToolIds(await agentService.getAgent(agentId))
      : [];
    const httpToolIds = await resolveHttpToolIds(
      httpToolValidator,
      body.httpToolIds ?? undefined,
      existingHttpToolIds,
    );
    const gitAllowedDomains = normalizeGitDomains(body.gitAllowedDomains);
    const agent = await agentService.updateAgent(
      userId,
      agentId,
      body.name,
      body.description,
      body.systemPrompt,
      body.skillNames,
      mcpServerIds,
      httpToolIds,
      toExperienceInputs(body.experiences),
      toSuggestedQuestionInputs(body.suggestedQuestions),
      body.isDefault,
      body.defaultModelId,
      body.avatarUrl,
      body.clientVisible,
      body.experienceLibraryEnabled,
      gitAllowedDomains,
    );
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.get('/v1/agents/:id/prompt-versions', async (request, reply) => {
    await requireAgentWrite(request);
    const versions = await agentService.listPromptVersions(pathId(request));
    const operatorIds = [...new Set(versions.map((v) => v.operatorId).filter((id): id is number => id != null))];
    const users = await Promise.all(operatorIds.map((id) => userRepo.findById(id)));
    const nameMap = new Map<number, string>();
    operatorIds.forEach((id, i) => {
      const user = users[i];
      if (user) nameMap.set(id, user.displayName || user.username || `用户#${id}`);
    });
    return sendOk(reply, versions.map((v) => ({
      ...v,
      operatorName: v.operatorId != null ? nameMap.get(v.operatorId) ?? null : null,
    })));
  });

  app.post('/v1/agents/:id/prompt-versions/:version/rollback', async (request, reply) => {
    const userId = await requireAgentWrite(request);
    const raw = (request.params as { version: string }).version;
    if (!/^[1-9]\d*$/.test(raw)) throw new BusinessException(ErrorCode.PARAM_INVALID, '版本号必须为正整数');
    const agent = await agentService.rollbackPrompt(pathId(request), Number(raw), userId);
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.patch('/v1/agents/:id/enabled', async (request, reply) => {
    await requireAgentWrite(request);
    const body = bodyOf<{ enabled?: boolean }>(request);
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
    }
    const agent = await agentService.setEnabled(pathId(request), body.enabled);
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.delete('/v1/agents/:id', async (request, reply) => {
    await requireAgentWrite(request);
    await agentService.deleteAgent(pathId(request));
    return sendOk(reply);
  });

  app.get('/v1/agents/:agentId/experiences', async (request, reply) => {
    requireUserId(request);
    const agentId = pathId(request, 'agentId');
    await agentService.getAgent(agentId);
    const list = (await experienceService.listByAgentId(agentId)).map(toExperienceVO);
    return sendOk(reply, list);
  });

  app.post('/v1/agents/:agentId/experiences', async (request, reply) => {
    await requireAgentWrite(request);
    const agentId = pathId(request, 'agentId');
    await agentService.getAgent(agentId);
    const body = bodyOf<ExperienceRequest>(request);
    const experience = await experienceService.create(agentId, body.content, body.sortOrder, body.enabled);
    return sendOk(reply, toExperienceVO(experience));
  });

  app.put('/v1/agents/:agentId/experiences/:id', async (request, reply) => {
    await requireAgentWrite(request);
    const agentId = pathId(request, 'agentId');
    await agentService.getAgent(agentId);
    const body = bodyOf<ExperienceRequest>(request);
    const experience = await experienceService.update(
      agentId,
      pathId(request),
      body.content,
      body.sortOrder,
      body.enabled,
    );
    return sendOk(reply, toExperienceVO(experience));
  });

  app.delete('/v1/agents/:agentId/experiences/:id', async (request, reply) => {
    await requireAgentWrite(request);
    const agentId = pathId(request, 'agentId');
    await agentService.getAgent(agentId);
    await experienceService.delete(agentId, pathId(request));
    return sendOk(reply);
  });
}

async function resolveMcpServerIds(
  validator: McpServerValidator,
  mcpServerIds: number[] | null | undefined,
): Promise<number[] | null | undefined> {
  if (mcpServerIds == null) {
    return mcpServerIds;
  }
  // 空数组是“清空关联”，不能塌缩成 null：更新语义里 null/undefined 表示不改动。
  if (mcpServerIds.length === 0) {
    return [];
  }
  return validator.validateForAgent(mcpServerIds);
}

async function resolveHttpToolIds(
  validator: HttpToolValidator,
  httpToolIds: number[] | null | undefined,
  existingIds: readonly number[] = [],
): Promise<number[] | null | undefined> {
  if (httpToolIds == null) {
    return httpToolIds;
  }
  // 运行时可能是任意 JSON：非数组直接给业务错误，避免 .length 读 undefined 后被兜底成 500。
  if (!Array.isArray(httpToolIds)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'httpToolIds 必须是正整数数组');
  }
  const normalized: number[] = [];
  for (const id of httpToolIds as unknown[]) {
    // 不依赖 MySQL 隐式转换：字符串 id 落库后运行时解析会被过滤成空关联（静默丢工具）。
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `httpToolIds 含非法 id：${String(id)}`);
    }
    normalized.push(id);
  }
  // 空数组是“清空关联”，不能塌缩成 null：更新语义里 null/undefined 表示不改动。
  if (normalized.length === 0) {
    return [];
  }
  return validator.validateForAgent(normalized, existingIds);
}

async function toVO(
  agent: Agent,
  agentService: AgentService,
  userRepo: UserRepository,
  opts?: { includeGitDomains?: boolean },
): Promise<AgentVO> {
  const vo: AgentVO = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    avatarUrl: agent.avatarUrl ?? null,
    systemPrompt: agent.systemPrompt,
    creatorId: agent.creatorId,
    isDefault: agent.isDefault != null && agent.isDefault === 1,
    enabled: agent.enabled !== 0,
    clientVisible: agent.clientVisible !== 0,
    experienceLibraryEnabled: agent.experienceLibraryEnabled !== 0,
    defaultModelId: agent.defaultModelId ?? null,
    createdAt: agent.createdAt ?? null,
    experiences: [],
    suggestedQuestions: [],
  };

  if (agent.creatorId != null) {
    const creator = await userRepo.findById(agent.creatorId);
    if (creator) {
      vo.creatorName = creator.displayName;
    }
  }

  if (agent.skillNames != null) {
    try {
      vo.skillNames = JSON.parse(agent.skillNames) as string[];
    } catch {
      // ignore deserialization error
    }
  }

  if (agent.mcpServerIds != null) {
    try {
      vo.mcpServerIds = JSON.parse(agent.mcpServerIds) as number[];
    } catch {
      // ignore deserialization error
    }
  }

  if (agent.httpToolIds != null) {
    try {
      vo.httpToolIds = JSON.parse(agent.httpToolIds) as number[];
    } catch {
      // ignore deserialization error
    }
  }

  // Git 凭据域（技术方案 2026-11-06）：仅对具备 Agent 管理权限的调用方返回（最小暴露）；
  // null（未配置）与 []（显式禁止）必须原样透出，前端据此区分「关闭开关」与「开启+空列表」。
  if (opts?.includeGitDomains !== false) {
    if (agent.gitAllowedDomains == null) {
      vo.gitAllowedDomains = null;
    } else {
      try {
        vo.gitAllowedDomains = JSON.parse(agent.gitAllowedDomains) as string[];
      } catch {
        // ignore deserialization error
      }
    }
  }

  const experiences = await agentService.getAgentExperiences(agent.id!);
  vo.experiences = experiences.map(toExperienceVO);

  const suggestedQuestions = await agentService.getAgentSuggestedQuestions(agent.id!);
  vo.suggestedQuestions = suggestedQuestions.map(toSuggestedQuestionVO);
  return vo;
}

function toExperienceVO(experience: AgentExperience): ExperienceVO {
  return {
    id: experience.id,
    content: experience.content,
    sortOrder: experience.sortOrder,
    enabled: experience.enabled != null && experience.enabled === 1,
  };
}

function toExperienceInputs(experiences: ExperienceVO[] | null | undefined): ExperienceInput[] | null {
  if (experiences == null) {
    return null;
  }
  return experiences.map((e) => experienceInputOf(e.id, e.content, e.sortOrder, e.enabled));
}

function toSuggestedQuestionVO(question: AgentSuggestedQuestion): SuggestedQuestionVO {
  return {
    id: question.id,
    content: question.content,
    sortOrder: question.sortOrder,
  };
}

function toSuggestedQuestionInputs(
  questions: SuggestedQuestionVO[] | null | undefined,
): SuggestedQuestionInput[] | null {
  if (questions == null) {
    return null;
  }
  return questions.map((q) => suggestedQuestionInputOf(q.id, q.content, q.sortOrder));
}
