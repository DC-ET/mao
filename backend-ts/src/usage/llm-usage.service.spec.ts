import { describe, expect, it, vi } from 'vitest';
import { LlmUsageService, type LlmUsageRepository } from './llm-usage.service.js';

describe('LlmUsageService', () => {
  it('recordsUsageRows', async () => {
    const repo = { insert: vi.fn(async () => 1) } as unknown as LlmUsageRepository;
    const service = new LlmUsageService(repo);
    await service.record(1, 2, 9, LlmUsageService.SCENE_GIT_COMMIT_MESSAGE, {
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
    }, true);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1,
      sessionId: 2,
      modelId: 9,
      scene: 'git_commit_message',
      success: 1,
      promptTokens: 10,
    }));
  });

  it('records null session for non-session calls', async () => {
    const repo = { insert: vi.fn(async () => 1) } as unknown as LlmUsageRepository;
    const service = new LlmUsageService(repo);
    await service.record(23, null, 9, LlmUsageService.SCENE_FEEDBACK_EXPERIENCE_DRAFT, null, false);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 23,
      sessionId: null,
      modelId: 9,
      scene: 'feedback_experience_draft',
      success: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }));
  });
});
