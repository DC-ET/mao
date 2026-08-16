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
});
