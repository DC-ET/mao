import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import type {
  Agent,
  AgentExperience,
  AgentRepository,
  AgentTag,
  AgentTagRepository,
  ExperienceInput,
} from './types.js';

export class AgentService {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly tagRepo: AgentTagRepository,
    private readonly experienceService: AgentExperienceService,
  ) {}

  listAgents(_userId: number, keyword?: string | null): Promise<Agent[]> {
    return this.agentRepo.selectList(keyword);
  }

  async getAgent(id: number): Promise<Agent> {
    const agent = await this.agentRepo.findById(id);
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    return agent;
  }

  getDefaultAgent(): Promise<Agent | null> {
    return this.agentRepo.findDefault();
  }

  async requireDefaultAgent(): Promise<Agent> {
    const agent = await this.getDefaultAgent();
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND, '未配置默认 Agent，请先在管理后台设置');
    }
    return agent;
  }

  async createAgent(
    userId: number,
    name: string,
    description: string | null | undefined,
    systemPrompt: string,
    tags: string[] | null | undefined,
    skillNames: string[] | null | undefined,
    mcpServerIds: number[] | null | undefined,
    experiences: ExperienceInput[] | null | undefined,
    isDefault: number | null | undefined,
  ): Promise<Agent> {
    if (isDefault != null && isDefault === 1) {
      await this.agentRepo.clearDefaultFlag();
    }
    const agent: Agent = {
      name,
      description,
      systemPrompt,
      creatorId: userId,
      isDefault: isDefault != null ? isDefault : 0,
    };
    if (skillNames != null && skillNames.length > 0) {
      agent.skillNames = JSON.stringify(skillNames);
    }
    if (mcpServerIds != null && mcpServerIds.length > 0) {
      agent.mcpServerIds = JSON.stringify(mcpServerIds);
    }
    await this.agentRepo.insert(agent);

    if (tags != null) {
      for (const tag of tags) {
        await this.tagRepo.insert({ agentId: agent.id!, tag });
      }
    }

    if (experiences != null) {
      await this.experienceService.syncExperiences(agent.id!, experiences);
    }

    return agent;
  }

  async updateAgent(
    id: number,
    name: string | null | undefined,
    description: string | null | undefined,
    systemPrompt: string | null | undefined,
    skillNames: string[] | null | undefined,
    mcpServerIds: number[] | null | undefined,
    tags: string[] | null | undefined,
    experiences: ExperienceInput[] | null | undefined,
    isDefault: number | null | undefined,
  ): Promise<Agent> {
    const agent = await this.getAgent(id);
    if (name != null) agent.name = name;
    if (description != null) agent.description = description;
    if (systemPrompt != null) agent.systemPrompt = systemPrompt;
    if (skillNames != null) {
      agent.skillNames = skillNames.length === 0 ? null : JSON.stringify(skillNames);
    }
    if (mcpServerIds != null) {
      agent.mcpServerIds = mcpServerIds.length === 0 ? null : JSON.stringify(mcpServerIds);
    }
    if (isDefault != null) {
      if (isDefault === 1) {
        await this.agentRepo.clearDefaultFlag();
      }
      agent.isDefault = isDefault;
    }
    await this.agentRepo.updateById(agent);

    if (tags != null) {
      await this.tagRepo.deleteByAgentId(id);
      for (const tag of tags) {
        await this.tagRepo.insert({ agentId: id, tag });
      }
    }

    await this.experienceService.syncExperiences(id, experiences);
    return agent;
  }

  async deleteAgent(id: number): Promise<void> {
    const agent = await this.getAgent(id);
    if (agent.isDefault != null && agent.isDefault === 1) {
      throw new BusinessException(ErrorCode.AGENT_IS_DEFAULT);
    }
    await this.tagRepo.deleteByAgentId(id);
    await this.experienceService.deleteByAgentId(id);
    await this.agentRepo.deleteById(id);
  }

  getAgentTags(agentId: number): Promise<AgentTag[]> {
    return this.tagRepo.listByAgentId(agentId);
  }

  getAgentExperiences(agentId: number): Promise<AgentExperience[]> {
    return this.experienceService.listByAgentId(agentId);
  }
}
