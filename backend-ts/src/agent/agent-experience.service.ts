import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { AgentExperience, AgentExperienceRepository, ExperienceInput } from './types.js';

export class AgentExperienceService {
  static readonly MAX_CONTENT_LENGTH = 300;

  constructor(private readonly experienceRepo: AgentExperienceRepository) {}

  listByAgentId(agentId: number): Promise<AgentExperience[]> {
    return this.experienceRepo.listByAgentId(agentId);
  }

  async listEnabledContents(agentId: number): Promise<string[]> {
    const rows = await this.experienceRepo.listEnabledByAgentId(agentId);
    return rows.map((row) => row.content).filter((content): content is string => content != null);
  }

  async getExperience(agentId: number, id: number): Promise<AgentExperience> {
    const experience = await this.experienceRepo.findById(id);
    if (!experience || experience.agentId !== agentId) {
      throw new BusinessException(ErrorCode.AGENT_EXPERIENCE_NOT_FOUND);
    }
    return experience;
  }

  async create(
    agentId: number,
    content: string | null | undefined,
    sortOrder: number | null | undefined,
    enabled: boolean | null | undefined,
  ): Promise<AgentExperience> {
    const experience: AgentExperience = {
      agentId,
      content: this.normalizeAndValidateContent(content),
      sortOrder: sortOrder != null ? sortOrder : 0,
      enabled: enabled == null || enabled ? 1 : 0,
    };
    await this.experienceRepo.insert(experience);
    return experience;
  }

  async update(
    agentId: number,
    id: number,
    content: string | null | undefined,
    sortOrder: number | null | undefined,
    enabled: boolean | null | undefined,
  ): Promise<AgentExperience> {
    const experience = await this.getExperience(agentId, id);
    if (content != null) {
      experience.content = this.normalizeAndValidateContent(content);
    }
    if (sortOrder != null) {
      experience.sortOrder = sortOrder;
    }
    if (enabled != null) {
      experience.enabled = enabled ? 1 : 0;
    }
    await this.experienceRepo.updateById(experience);
    return experience;
  }

  async delete(agentId: number, id: number): Promise<void> {
    const experience = await this.getExperience(agentId, id);
    await this.experienceRepo.deleteById(experience.id!);
  }

  deleteByAgentId(agentId: number): Promise<void> {
    return this.experienceRepo.deleteByAgentId(agentId);
  }

  /**
   * 全量同步：带 id 且属于该 Agent → 更新；无 id → 新增；库中多余 → 删除。
   * items == null 时不改动。
   */
  async syncExperiences(agentId: number, items: ExperienceInput[] | null | undefined): Promise<void> {
    if (items == null) {
      return;
    }

    const existing = await this.experienceRepo.listByAgentId(agentId);
    const existingIds = new Set(existing.map((row) => row.id!));
    const keepIds = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = this.normalizeAndValidateContent(item.content);
      const sortOrder = item.sortOrder != null ? item.sortOrder : i;
      const enabled = item.enabled == null || item.enabled ? 1 : 0;

      if (item.id != null && existingIds.has(item.id)) {
        const experience = await this.experienceRepo.findById(item.id);
        if (experience) {
          experience.content = content;
          experience.sortOrder = sortOrder;
          experience.enabled = enabled;
          await this.experienceRepo.updateById(experience);
        }
        keepIds.add(item.id);
      } else {
        const experience: AgentExperience = { agentId, content, sortOrder, enabled };
        await this.experienceRepo.insert(experience);
        keepIds.add(experience.id!);
      }
    }

    for (const experience of existing) {
      if (!keepIds.has(experience.id!)) {
        await this.experienceRepo.deleteById(experience.id!);
      }
    }
  }

  normalizeAndValidateContent(content: string | null | undefined): string {
    if (content == null) {
      throw new BusinessException(ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID);
    }
    const trimmed = content.trim();
    if (trimmed.length === 0 || trimmed.length > AgentExperienceService.MAX_CONTENT_LENGTH) {
      throw new BusinessException(ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID);
    }
    return trimmed;
  }
}

export function experienceInputOf(
  id: number | null | undefined,
  content: string | null | undefined,
  sortOrder: number | null | undefined,
  enabled: boolean | null | undefined,
): ExperienceInput {
  return { id, content, sortOrder, enabled };
}
