import { describe, expect, it, vi } from 'vitest';
import { LlmCallService } from './llm-call.service.js';
import { LlmCallContext } from './llm-call-context.js';

describe('LlmCallService 成本记取（§5.2 / §5.3）', () => {
  const USAGE = {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    promptTokensDetails: { cachedTokens: 400 },
  };
  const ANTHROPIC_USAGE = {
    promptTokens: 1200,
    completionTokens: 200,
    totalTokens: 1400,
    promptTokensDetails: { cachedTokens: 400, cacheCreationTokens: 200 },
  };
  const PRICED_CONFIG = {
    id: 3,
    name: 'M',
    provider: 'p',
    modelId: 'gpt',
    baseUrl: 'http://x',
    apiKey: 'k',
    priceInput: 2,
    priceCacheRead: 1,
    priceCacheWrite: 2,
    priceOutput: 8,
  };

  function build(options: { priceLookup?: ((id: number) => Promise<Record<string, unknown> | null>) | null } = {}) {
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
        modelConfig: { ...PRICED_CONFIG, priceInput: null, priceCacheRead: null, priceCacheWrite: null, priceOutput: null },
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
    const lookup = vi.fn(async () => ({ priceInput: '2', priceCacheRead: '1', priceCacheWrite: '2', priceOutput: '8' }));
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

  it('兜底路径：缓存写 token 计入成本（Anthropic 结构）', async () => {
    const lookup = vi.fn(async () => ({ priceInput: '2', priceCacheRead: '1', priceCacheWrite: '2', priceOutput: '8' }));
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({
        modelConfig: { id: 3, name: 'M' },
        stream: false,
        usage: ANTHROPIC_USAGE,
        success: true,
        durationMs: 1,
      });
    });
    // 600×2 + 400×1 + 200×2 + 200×8 = 3600
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      costMicros: 3600,
      cacheCreationTokens: 200,
    }));
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
    const lookup = vi.fn(async () => ({ priceInput: '2', priceCacheRead: '1', priceCacheWrite: '2', priceOutput: '8' }));
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
    const lookup = vi.fn(async () => ({ priceInput: '2.5', priceCacheRead: '' }));
    const { service, repo } = build({ priceLookup: lookup });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({ modelConfig: { id: 3 }, stream: false, usage: USAGE, success: true, durationMs: 1 });
    });
    // cachedTokens=400 > 0 而 priceCacheRead 为空 → NULL
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null }));
  });

  it('cache_creation_tokens 落库：无缓存写时归一为 0', async () => {
    const { service, repo } = build({ priceLookup: async () => ({ priceInput: '2', priceCacheRead: '1', priceCacheWrite: '2', priceOutput: '8' }) });
    await LlmCallContext.runAsync({ scene: 'compaction' }, async () => {
      await service.record({ modelConfig: { id: 3 }, stream: false, usage: USAGE, success: true, durationMs: 1 });
    });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ cacheCreationTokens: 0 }));
  });
});

describe('LlmCallService 用户端用量汇总（/v1/llm-calls/me/summary|trends）', () => {
  const EMPTY_TOTALS = {
    callCount: 0,
    successCount: 0,
    failCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    cost: 0,
  };

  function build() {
    const repo = {
      aggregateSummary: vi.fn(async () => ({ ...EMPTY_TOTALS })),
      aggregateByModel: vi.fn(async () => []),
      aggregateByScene: vi.fn(async () => []),
      aggregateTrend: vi.fn(async () => []),
    };
    const service = new LlmCallService(repo as never);
    return { service, repo };
  }

  /** 冻结到上海时区 2026-10-10 12:00，窗口断言不随真实日期漂移。 */
  function freeze(date: Date) {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  }

  it('summaryForUser：默认 30 天闭区间窗口，三个聚合均带 userId', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    const result = await service.summaryForUser(7);
    expect(result.days).toBe(30);
    for (const mock of [repo.aggregateSummary, repo.aggregateByModel, repo.aggregateByScene]) {
      expect(mock).toHaveBeenCalledWith(7, expect.objectContaining({
        startAt: '2026-09-11 00:00:00',
        endAt: '2026-10-10 23:59:59',
      }));
    }
    vi.useRealTimers();
  });

  it('summaryForUser：days 非法/越界钳制（缺省 30、下限 1、上限 365）', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    await service.summaryForUser(7, undefined);
    expect(repo.aggregateSummary).toHaveBeenCalledWith(7, expect.objectContaining({ startAt: '2026-09-11 00:00:00' }));
    await service.summaryForUser(7, Number.NaN);
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({ startAt: '2026-09-11 00:00:00' }));
    await service.summaryForUser(7, 0);
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({ startAt: '2026-10-10 00:00:00' }));
    await service.summaryForUser(7, 9999);
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({ startAt: '2025-10-11 00:00:00' }));
    vi.useRealTimers();
  });

  it('trendsForUser：窗口一致，granularity 透传且默认 day', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    const day = await service.trendsForUser(7, 7);
    expect(day.days).toBe(7);
    expect(day.granularity).toBe('day');
    // 无数据时补齐 7 个连续零桶（10-04..10-10），前端拿到的序列无缺口
    expect(day.buckets.map((b) => b.bucket)).toEqual([
      '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
    ]);
    expect(day.buckets.every((b) => b.callCount === 0 && b.totalTokens === 0 && b.cost === 0)).toBe(true);
    expect(repo.aggregateTrend).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ startAt: '2026-10-04 00:00:00', endAt: '2026-10-10 23:59:59' }),
      'day',
    );
    await service.trendsForUser(7, 7, 'hour');
    expect(repo.aggregateTrend).toHaveBeenLastCalledWith(7, expect.anything(), 'hour');
    vi.useRealTimers();
  });

  it('trendsForUser：hour 粒度补零到当前整点，不出现未来桶', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service } = build();
    const hour = await service.trendsForUser(7, 1, 'hour');
    expect(hour.granularity).toBe('hour');
    // 窗口=今天：00:00..12:00 共 13 个整点桶
    expect(hour.buckets).toHaveLength(13);
    expect(hour.buckets[0].bucket).toBe('2026-10-10 00:00');
    expect(hour.buckets[12].bucket).toBe('2026-10-10 12:00');
    vi.useRealTimers();
  });

  it('trendsForUser：有数据的桶原样保留，其余补零', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const repo = {
      aggregateSummary: vi.fn(),
      aggregateByModel: vi.fn(),
      aggregateByScene: vi.fn(),
      aggregateTrend: vi.fn(async () => [
        { bucket: '2026-10-09', callCount: 3, failCount: 1, totalTokens: 300, cost: 0.5 },
      ]),
    };
    const service = new LlmCallService(repo as never);
    const day = await service.trendsForUser(7, 3);
    expect(day.buckets).toEqual([
      { bucket: '2026-10-08', callCount: 0, failCount: 0, totalTokens: 0, cost: 0 },
      { bucket: '2026-10-09', callCount: 3, failCount: 1, totalTokens: 300, cost: 0.5 },
      { bucket: '2026-10-10', callCount: 0, failCount: 0, totalTokens: 0, cost: 0 },
    ]);
    vi.useRealTimers();
  });
});
