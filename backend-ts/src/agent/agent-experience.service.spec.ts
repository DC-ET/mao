import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { AgentExperienceService, experienceInputOf } from './agent-experience.service.js';
import type { AgentExperience, AgentExperienceRepository } from './types.js';

function experience(
  id: number,
  agentId: number,
  content: string,
  sortOrder: number,
  enabled: number,
): AgentExperience {
  return { id, agentId, content, sortOrder, enabled };
}

describe('AgentExperienceService', () => {
  const repo: AgentExperienceRepository = {
    listByAgentId: vi.fn(),
    listEnabledByAgentId: vi.fn(),
    findById: vi.fn(),
    insert: vi.fn(async (exp) => {
      exp.id = exp.id ?? 7;
      return exp.id;
    }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    deleteByAgentId: vi.fn(),
  };
  const service = new AgentExperienceService(repo);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repo.insert).mockImplementation(async (exp) => {
      exp.id = exp.id ?? 7;
      return exp.id;
    });
  });

  it('rejectsBlankOrTooLongContent', () => {
    expect(() => service.normalizeAndValidateContent('  ')).toThrow(BusinessException);
    try {
      service.normalizeAndValidateContent('  ');
    } catch (e) {
      expect((e as BusinessException).code).toBe(ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID.code);
    }
    expect(() => service.normalizeAndValidateContent('a'.repeat(301))).toThrow(BusinessException);
  });

  it('listEnabledContentsReturnsOnlyEnabledInOrder', async () => {
    const a = experience(1, 10, 'first', 0, 1);
    const b = experience(2, 10, 'disabled', 1, 0);
    const c = experience(3, 10, 'second', 2, 1);
    vi.mocked(repo.listEnabledByAgentId).mockResolvedValue([a, c]);

    expect(await service.listEnabledContents(10)).toEqual(['first', 'second']);
    expect(b.content).toBe('disabled');
  });

  it('syncExperiencesUpdatesInsertsAndDeletes', async () => {
    const existingKeep = experience(1, 5, 'old', 0, 1);
    const existingDrop = experience(2, 5, 'drop', 1, 1);
    vi.mocked(repo.listByAgentId).mockResolvedValue([existingKeep, existingDrop]);
    vi.mocked(repo.findById).mockResolvedValue(existingKeep);
    vi.mocked(repo.insert).mockImplementation(async (exp) => {
      exp.id = 99;
      return 99;
    });

    await service.syncExperiences(5, [
      experienceInputOf(1, 'updated', 0, true),
      experienceInputOf(null, 'new one', 1, false),
    ]);

    expect(existingKeep.content).toBe('updated');
    expect(repo.updateById).toHaveBeenCalledWith(existingKeep);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ content: 'new one', enabled: 0 }));
    expect(repo.deleteById).toHaveBeenCalledWith(2);
  });

  it('syncExperiencesNullDoesNothing', async () => {
    await service.syncExperiences(5, null);
    expect(repo.listByAgentId).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(repo.deleteById).not.toHaveBeenCalled();
  });

  it('syncExperiencesEmptyClearsAll', async () => {
    const existing = experience(1, 5, 'old', 0, 1);
    vi.mocked(repo.listByAgentId).mockResolvedValue([existing]);

    await service.syncExperiences(5, []);

    expect(repo.deleteById).toHaveBeenCalledTimes(1);
    expect(repo.deleteById).toHaveBeenCalledWith(1);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('createAndUpdateAndDelete', async () => {
    vi.mocked(repo.insert).mockImplementation(async (exp) => {
      exp.id = 7;
      return 7;
    });
    const created = await service.create(3, '  tip  ', 2, null);
    expect(created.content).toBe('tip');
    expect(created.enabled).toBe(1);

    const existing = experience(7, 3, 'tip', 2, 1);
    vi.mocked(repo.findById).mockResolvedValue(existing);
    const updated = await service.update(3, 7, 'new tip', 0, false);
    expect(updated.content).toBe('new tip');
    expect(updated.enabled).toBe(0);

    await service.delete(3, 7);
    expect(repo.deleteById).toHaveBeenCalledWith(7);
  });

  it('getExperienceThrowsWhenWrongAgent', async () => {
    vi.mocked(repo.findById).mockResolvedValue(experience(1, 99, 'x', 0, 1));
    await expect(service.getExperience(3, 1)).rejects.toMatchObject({
      code: ErrorCode.AGENT_EXPERIENCE_NOT_FOUND.code,
    });
  });
});
