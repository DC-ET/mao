import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import {
  AgentSuggestedQuestionService,
  suggestedQuestionInputOf,
} from './agent-suggested-question.service.js';
import type { AgentSuggestedQuestion, AgentSuggestedQuestionRepository } from './types.js';

function question(
  id: number,
  agentId: number,
  content: string,
  sortOrder: number,
): AgentSuggestedQuestion {
  return { id, agentId, content, sortOrder };
}

describe('AgentSuggestedQuestionService', () => {
  const repo: AgentSuggestedQuestionRepository = {
    listByAgentId: vi.fn(),
    findById: vi.fn(),
    insert: vi.fn(async (q) => {
      q.id = q.id ?? 7;
      return q.id;
    }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    deleteByAgentId: vi.fn(),
  };
  const service = new AgentSuggestedQuestionService(repo);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repo.insert).mockImplementation(async (q) => {
      q.id = q.id ?? 7;
      return q.id;
    });
  });

  it('rejectsBlankOrTooLongContent', () => {
    expect(() => service.normalizeAndValidateContent('  ')).toThrow(BusinessException);
    try {
      service.normalizeAndValidateContent('  ');
    } catch (e) {
      expect((e as BusinessException).code).toBe(
        ErrorCode.AGENT_SUGGESTED_QUESTION_CONTENT_INVALID.code,
      );
    }
    expect(() => service.normalizeAndValidateContent('a'.repeat(101))).toThrow(BusinessException);
  });

  it('rejectsMoreThanFiveItems', async () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      suggestedQuestionInputOf(null, `q${i}`, i),
    );
    await expect(service.syncSuggestedQuestions(5, items)).rejects.toMatchObject({
      code: ErrorCode.AGENT_SUGGESTED_QUESTION_LIMIT_EXCEEDED.code,
    });
  });

  it('syncUpdatesInsertsAndDeletes', async () => {
    const keep = question(1, 5, 'old', 0);
    const drop = question(2, 5, 'drop', 1);
    vi.mocked(repo.listByAgentId).mockResolvedValue([keep, drop]);
    vi.mocked(repo.findById).mockResolvedValue(keep);
    vi.mocked(repo.insert).mockImplementation(async (q) => {
      q.id = 99;
      return 99;
    });

    await service.syncSuggestedQuestions(5, [
      suggestedQuestionInputOf(1, 'updated', 0),
      suggestedQuestionInputOf(null, 'new one', 1),
    ]);

    expect(keep.content).toBe('updated');
    expect(repo.updateById).toHaveBeenCalledWith(keep);
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'new one', sortOrder: 1 }),
    );
    expect(repo.deleteById).toHaveBeenCalledWith(2);
  });

  it('syncNullDoesNothing', async () => {
    await service.syncSuggestedQuestions(5, null);
    expect(repo.listByAgentId).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(repo.deleteById).not.toHaveBeenCalled();
  });

  it('syncEmptyClearsAll', async () => {
    const existing = question(1, 5, 'old', 0);
    vi.mocked(repo.listByAgentId).mockResolvedValue([existing]);

    await service.syncSuggestedQuestions(5, []);

    expect(repo.deleteById).toHaveBeenCalledTimes(1);
    expect(repo.deleteById).toHaveBeenCalledWith(1);
    expect(repo.insert).not.toHaveBeenCalled();
  });
});
