import { validateAgentAvatarUrl } from './agent-avatar.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import type {
  Agent,
  AgentExperience,
  AgentRepository,
  ExperienceInput,
} from './types.js';

/** Agent 默认模型校验所需的最小模型查询能力 */
export interface AgentModelLookup {
  findById(id: number): Promise<{ id?: number; status?: number | null } | null>;
}

export class AgentService {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly experienceService: AgentExperienceService,
    private readonly modelLookup?: AgentModelLookup,
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
    skillNames: string[] | null | undefined,
    mcpServerIds: number[] | null | undefined,
    experiences: ExperienceInput[] | null | undefined,
    isDefault: number | null | undefined,
    defaultModelId: number | null | undefined,
    avatarUrl?: string | null,
  ): Promise<Agent> {
    validateAgentAvatarUrl(avatarUrl);
    if (isDefault != null && isDefault === 1) {
      await this.agentRepo.clearDefaultFlag();
    }
    await this.requireEnabledModel(defaultModelId);
    const agent: Agent = {
      name,
      description,
      avatarUrl: avatarUrl ?? null,
      systemPrompt,
      creatorId: userId,
      defaultModelId: defaultModelId ?? null,
      isDefault: isDefault != null ? isDefault : 0,
    };
    if (skillNames != null && skillNames.length > 0) {
      agent.skillNames = JSON.stringify(skillNames);
    }
    if (mcpServerIds != null && mcpServerIds.length > 0) {
      agent.mcpServerIds = JSON.stringify(mcpServerIds);
    }
    await this.agentRepo.insert(agent);

    if (experiences != null) {
      await this.experienceService.syncExperiences(agent.id!, experiences);
    }

    return agent;
  }

  async updateAgent(
    operatorId: number,
    id: number,
    name: string | null | undefined,
    description: string | null | undefined,
    systemPrompt: string | null | undefined,
    skillNames: string[] | null | undefined,
    mcpServerIds: number[] | null | undefined,
    experiences: ExperienceInput[] | null | undefined,
    isDefault: number | null | undefined,
    defaultModelId: number | null | undefined,
    avatarUrl?: string | null,
  ): Promise<Agent> {
    validateAgentAvatarUrl(avatarUrl);
    const agent = await this.getAgent(id);
    if (avatarUrl !== undefined) agent.avatarUrl = avatarUrl;
    if (name != null) agent.name = name;
    if (description != null) agent.description = description;
    if (systemPrompt != null) agent.systemPrompt = systemPrompt;
    if (skillNames != null) {
      agent.skillNames = skillNames.length === 0 ? null : JSON.stringify(skillNames);
    }
    if (mcpServerIds != null) {
      agent.mcpServerIds = mcpServerIds.length === 0 ? null : JSON.stringify(mcpServerIds);
    }
    if (defaultModelId !== undefined) {
      await this.requireEnabledModel(defaultModelId);
      agent.defaultModelId = defaultModelId;
    }
    if (isDefault != null) {
      if (isDefault === 1) {
        await this.agentRepo.clearDefaultFlag();
      }
      agent.isDefault = isDefault;
    }
    await this.agentRepo.updateById(agent, operatorId, systemPrompt != null);

    await this.experienceService.syncExperiences(id, experiences);
    return agent;
  }

  async listPromptVersions(id: number) {
    await this.getAgent(id);
    return this.agentRepo.listPromptVersions(id);
  }

  async rollbackPrompt(id: number, version: number, operatorId: number): Promise<Agent> {
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '版本号必须为正整数');
    }
    return this.agentRepo.rollbackPrompt(id, version, operatorId);
  }

  async deleteAgent(id: number): Promise<void> {
    const agent = await this.getAgent(id);
    if (agent.isDefault != null && agent.isDefault === 1) {
      throw new BusinessException(ErrorCode.AGENT_IS_DEFAULT);
    }
    await this.experienceService.deleteByAgentId(id);
    await this.agentRepo.deleteById(id);
  }

  /** 默认模型必须存在且启用；null/undefined 表示未配置，直接跳过 */
  private async requireEnabledModel(defaultModelId: number | null | undefined): Promise<void> {
    if (defaultModelId == null) return;
    if (this.modelLookup == null) return;
    const model = await this.modelLookup.findById(defaultModelId);
    if (model == null || model.status !== 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '默认模型不存在或未启用');
    }
  }

  async removeSkillNameFromAll(skillName: string): Promise<number> {
    return this.agentRepo.removeSkillName(skillName);
  }

  getAgentExperiences(agentId: number): Promise<AgentExperience[]> {
    return this.experienceService.listByAgentId(agentId);
  }
}
