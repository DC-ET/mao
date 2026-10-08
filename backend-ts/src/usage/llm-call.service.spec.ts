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

describe('LlmCallService 成本记取（§5.2 / §5.3）', () => {
  const USAGE = {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    promptTokensDetails: { cachedTokens: 400 },
  };
  const PRICED_CONFIG = { id: 3, name: 'M', provider: 'p', modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k', priceInput: 2, priceOutput: 8 };

  function build(options: { priceLookup?: ((id: number) => Promise<{ priceInput?: unknown; priceOutput?: unknown } | null>) | null } = {}) {
    const repo = { insert: vi.fn(async () => 1), list: vi.fn(async () => ({ records: [], total: 0 })) };
    const service = new LlmCallService(
      repo as never,
      undefined,
      undefined,
      options.priceLookup === undefined ? undefined : options.priceLookup,
    );
    return { service, repo };
  }

  it('主路径：调用方快照 costMicros 原样落库，不再回查价格', async () => {
    const lookup = vi.fn(async () => ({ priceInput: '9', priceOutput: '9' }));
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction', userId: 7, sessionId: 8, agentId: 9 }, async () => {
      await service.record({
        modelConfig: PRICED_CONFIG,
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
        costMicros: 3200,
      });
    });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: 3200 }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('模型未配价（显式 null）→ NULL 成本，不回查兜底', async () => {
    const lookup = vi.fn(async () => ({ priceInput: '9', priceOutput: '9' }));
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({
        modelConfig: { ...PRICED_CONFIG, priceInput: null, priceOutput: null },
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
        costMicros: null,
      });
    });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('兜底路径：价格未随配置下发 → 查模型价格行计价', async () => {
    const lookup = vi.fn(async () => ({ priceInput: '2', priceOutput: '8' }));
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({
        modelConfig: { id: 3, name: 'M', provider: 'p', modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k' },
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
      });
    });
    expect(lookup).toHaveBeenCalledWith(3);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: 3200 }));
  });

  it('兜底路径：模型不存在 / 未注入 lookup → NULL 成本', async () => {
    const missing = build({ priceLookup: async () => null });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await missing.service.record({
        modelConfig: { id: 3, name: 'M' },
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
      });
    });
    expect(missing.repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null }));

    const noLookup = build();
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await noLookup.service.record({
        modelConfig: { id: 3, name: 'M' },
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
      });
    });
    expect(noLookup.repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null }));
  });

  it('价格缓存 60s TTL：同模型连续调用只查一次（含未配价负缓存）', async () => {
    const lookup = vi.fn(async () => ({ priceInput: '2', priceOutput: '8' }));
    const { service } = build({ priceLookup: lookup });
    for (let i = 0; i < 3; i++) {
      await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
        await service.record({ modelConfig: { id: 3 }, stream: false, usage: USAGE, success: true, durationMs: 1 });
      });
    }
    expect(lookup).toHaveBeenCalledTimes(1);

    const negative = vi.fn(async () => null);
    const negService = build({ priceLookup: negative }).service;
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await negService.record({ modelConfig: { id: 7 }, stream: false, usage: USAGE, success: true, durationMs: 1 });
      await negService.record({ modelConfig: { id: 7 }, stream: false, usage: USAGE, success: true, durationMs: 1 });
    });
    expect(negative).toHaveBeenCalledTimes(1);
  });

  it('价格查询异常 → NULL 成本且不中断落库', async () => {
    const lookup = vi.fn(async () => { throw new Error('db down'); });
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({ modelConfig: { id: 3 }, stream: false, usage: USAGE, success: false, durationMs: 1 });
    });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null }));
  });

  it('价格 DECIMAL 字符串与空串解析：空串视为未配价', async () => {
    const lookup = vi.fn(async () => ({ priceInput: '2.5', priceOutput: '' }));
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({ modelConfig: { id: 3 }, stream: false, usage: USAGE, success: true, durationMs: 1 });
    });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null }));
  });
});
