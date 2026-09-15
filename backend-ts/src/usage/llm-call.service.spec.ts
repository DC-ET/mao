import { describe, expect, it, vi } from 'vitest';
import { LlmCallService } from './llm-call.service.js';
import type { LlmCallRepository } from './llm-call.repository.js';
import { LLM_CALL_SCENES, LlmCallContext } from './llm-call-context.js';

describe('LlmCallService', () => {
  it('persists call with ALS context', async () => {
    const repo = {
      insert: vi.fn(async () => 1),
      list: vi.fn(),
    } as unknown as LlmCallRepository;
    const service = new LlmCallService(repo);
    await LlmCallContext.runAsync({
      scene: LLM_CALL_SCENES.COMPACTION,
      userId: 7,
      sessionId: 8,
      agentId: 9,
    }, async () => {
      await service.record({
        modelConfig: { id: 3, name: 'M', provider: 'p', modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k' },
        stream: true,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, promptTokensDetails: { cachedTokens: 1 } },
        success: true,
        durationMs: 120,
        firstTokenMs: 40,
        retryCount: 1,
      });
    });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      sessionId: 8,
      agentId: 9,
      scene: 'compaction',
      stream: 1,
      promptTokens: 1,
      completionTokens: 2,
      cachedTokens: 1,
      totalTokens: 3,
      success: 1,
      durationMs: 120,
      firstTokenMs: 40,
      retryCount: 1,
    }));
  });

  it('listForUser forces user filter', async () => {
    const repo = {
      insert: vi.fn(),
      list: vi.fn(async () => ({ records: [{ id: 1, userId: 5 }], total: 1 })),
    } as unknown as LlmCallRepository;
    const service = new LlmCallService(repo);
    const result = await service.listForUser(5, 1, 20, {});
    expect(repo.list).toHaveBeenCalledWith(1, 20, { userId: 5 });
    expect(result.records[0].userId).toBe(5);
  });
});
