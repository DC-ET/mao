import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { AgentService } from './agent.service.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import { experienceInputOf } from './agent-experience.service.js';
import type { Agent, AgentRepository, AgentTag, AgentTagRepository } from './types.js';

function agent(id: number, name: string, isDefault: number): Agent {
  return { id, name, systemPrompt: 'p', isDefault };
}

describe('AgentService', () => {
  const agentRepo: AgentRepository = {
    selectList: vi.fn(),
    findById: vi.fn(),
    findDefault: vi.fn(),
    insert: vi.fn(async (a) => {
      a.id = a.id ?? 1;
      return a.id;
    }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    clearDefaultFlag: vi.fn(),
    removeSkillName: vi.fn(),
  };
  const tagRepo: AgentTagRepository = {
    listByAgentId: vi.fn(),
    insert: vi.fn(),
    deleteByAgentId: vi.fn(),
  };
  const experienceService = {
    syncExperiences: vi.fn(),
    deleteByAgentId: vi.fn(),
    listByAgentId: vi.fn(),
  } as unknown as AgentExperienceService;
  const service = new AgentService(agentRepo, tagRepo, experienceService);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentRepo.insert).mockImplementation(async (a) => {
      a.id = a.id ?? 1;
      return a.id;
    });
  });

  it('listsGetsCreatesUpdatesDeletesAndLoadsTags', async () => {
    const existing = agent(1, 'old', 0);
    const tag: AgentTag = { agentId: 1, tag: 'java' };
    vi.mocked(agentRepo.selectList).mockResolvedValue([existing]);
    vi.mocked(agentRepo.findById).mockResolvedValue(existing);
    vi.mocked(tagRepo.listByAgentId).mockResolvedValue([tag]);

    expect(await service.listAgents(7, 'old')).toEqual([existing]);
    expect(await service.getAgent(1)).toBe(existing);
    expect(await service.getAgentTags(1)).toEqual([tag]);

    const experiences = [experienceInputOf(null, 'tip', 0, true)];
    const created = await service.createAgent(
      7,
      'coder',
      'desc',
      'prompt',
      ['java', 'spring'],
      ['skill-a'],
      [10, 20],
      experiences,
      1,
    );
    expect(created.creatorId).toBe(7);
    expect(created.skillNames).toContain('skill-a');
    expect(created.mcpServerIds).toContain('10');
    expect(created.isDefault).toBe(1);
    expect(agentRepo.insert).toHaveBeenCalledWith(created);
    expect(tagRepo.insert).toHaveBeenCalledTimes(2);
    expect(experienceService.syncExperiences).toHaveBeenCalledWith(created.id, experiences);

    const updated = await service.updateAgent(
      1,
      'new',
      null,
      'new prompt',
      [],
      [],
      ['backend'],
      experiences,
      0,
    );
    expect(updated.name).toBe('new');
    expect(updated.skillNames).toBeNull();
    expect(updated.isDefault).toBe(0);
    expect(agentRepo.updateById).toHaveBeenCalledWith(existing);
    expect(tagRepo.deleteByAgentId).toHaveBeenCalledWith(1);
    expect(experienceService.syncExperiences).toHaveBeenCalledWith(1, experiences);

    await service.deleteAgent(1);
    expect(experienceService.deleteByAgentId).toHaveBeenCalledWith(1);
    expect(agentRepo.deleteById).toHaveBeenCalledWith(1);
  });

  it('getAgentThrowsWhenMissing', async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(null);
    await expect(service.getAgent(404)).rejects.toBeInstanceOf(BusinessException);
  });

  it('deleteRejectsDefaultAgent', async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(agent(1, 'default', 1));
    await expect(service.deleteAgent(1)).rejects.toMatchObject({
      code: ErrorCode.AGENT_IS_DEFAULT.code,
    });
  });

  it('requireDefaultAgentThrowsWhenMissing', async () => {
    vi.mocked(agentRepo.findDefault).mockResolvedValue(null);
    await expect(service.requireDefaultAgent()).rejects.toBeInstanceOf(BusinessException);
  });
});
