import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { UserRepository } from '../user/types.js';
import { experienceInputOf } from './agent-experience.service.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import type { AgentService } from './agent.service.js';
import type {
  Agent,
  AgentExperience,
  AgentVO,
  ExperienceInput,
  ExperienceVO,
  McpServerValidator,
} from './types.js';

export interface AgentRouteDeps {
  agentService: AgentService;
  experienceService: AgentExperienceService;
  userRepo: UserRepository;
  mcpServerValidator: McpServerValidator;
}

interface CreateAgentRequest {
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  tags?: string[];
  skillNames?: string[];
  mcpServerIds?: number[];
  experiences?: ExperienceVO[];
  isDefault?: number | null;
}

interface UpdateAgentRequest {
  name?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  skillNames?: string[] | null;
  mcpServerIds?: number[] | null;
  tags?: string[] | null;
  experiences?: ExperienceVO[] | null;
  isDefault?: number | null;
}

interface ExperienceRequest {
  content?: string;
  sortOrder?: number | null;
  enabled?: boolean | null;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { agentService, experienceService, userRepo, mcpServerValidator } = deps;

  app.get('/v1/agents', async (request, reply) => {
    const userId = requireUserId(request);
    const keyword = (request.query as { keyword?: string }).keyword;
    const agents = await agentService.listAgents(userId, keyword);
    const voList = await Promise.all(agents.map((agent) => toVO(agent, agentService, userRepo)));
    return sendOk(reply, voList);
  });

  app.get('/v1/agents/:id', async (request, reply) => {
    requireUserId(request);
    const agent = await agentService.getAgent(pathId(request));
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.post('/v1/agents', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<CreateAgentRequest>(request);
    if (!hasText(body.name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Agent 名称不能为空');
    }
    if (!hasText(body.systemPrompt)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '角色定义不能为空');
    }
    const mcpServerIds = await resolveMcpServerIds(mcpServerValidator, body.mcpServerIds);
    const agent = await agentService.createAgent(
      userId,
      body.name!,
      body.description,
      body.systemPrompt!,
      body.tags,
      body.skillNames,
      mcpServerIds,
      toExperienceInputs(body.experiences),
      body.isDefault,
    );
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.put('/v1/agents/:id', async (request, reply) => {
    requireUserId(request);
    const body = bodyOf<UpdateAgentRequest>(request);
    const mcpServerIds = await resolveMcpServerIds(mcpServerValidator, body.mcpServerIds ?? undefined);
    const agent = await agentService.updateAgent(
      pathId(request),
      body.name,
      body.description,
      body.systemPrompt,
      body.skillNames,
      mcpServerIds,
      body.tags,
      toExperienceInputs(body.experiences),
      body.isDefault,
    );
    return sendOk(reply, await toVO(agent, agentService, userRepo));
  });

  app.delete('/v1/agents/:id', async (request, reply) => {
    requireUserId(request);
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
    requireUserId(request);
    const agentId = pathId(request, 'agentId');
    await agentService.getAgent(agentId);
    const body = bodyOf<ExperienceRequest>(request);
    const experience = await experienceService.create(agentId, body.content, body.sortOrder, body.enabled);
    return sendOk(reply, toExperienceVO(experience));
  });

  app.put('/v1/agents/:agentId/experiences/:id', async (request, reply) => {
    requireUserId(request);
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
    requireUserId(request);
    const agentId = pathId(request, 'agentId');
    await agentService.getAgent(agentId);
    await experienceService.delete(agentId, pathId(request));
    return sendOk(reply);
  });
}

async function resolveMcpServerIds(
  validator: McpServerValidator,
  mcpServerIds: number[] | null | undefined,
): Promise<number[] | null> {
  if (mcpServerIds == null || mcpServerIds.length === 0) {
    return null;
  }
  return validator.validateForAgent(mcpServerIds);
}

async function toVO(agent: Agent, agentService: AgentService, userRepo: UserRepository): Promise<AgentVO> {
  const vo: AgentVO = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    creatorId: agent.creatorId,
    isDefault: agent.isDefault != null && agent.isDefault === 1,
    createdAt: agent.createdAt ?? null,
    experiences: [],
  };

  if (agent.creatorId != null) {
    const creator = await userRepo.findById(agent.creatorId);
    if (creator) {
      vo.creatorName = creator.displayName;
    }
  }

  const tags = await agentService.getAgentTags(agent.id!);
  vo.tags = tags.map((t) => t.tag);

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

  const experiences = await agentService.getAgentExperiences(agent.id!);
  vo.experiences = experiences.map(toExperienceVO);
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
