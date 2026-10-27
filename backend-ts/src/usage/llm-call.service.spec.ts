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

  function build(agentLookup?: { findName: (id: number) => Promise<string | null> }) {
    const repo = {
      aggregateSummary: vi.fn(async () => ({ ...EMPTY_TOTALS })),
      aggregateByModel: vi.fn(async () => []),
      aggregateByScene: vi.fn(async () => []),
      aggregateByAgent: vi.fn(async () => []),
      aggregateTrend: vi.fn(async () => []),
    };
    const service = new LlmCallService(repo as never, undefined, agentLookup);
    return { service, repo };
  }

  it('summaryForUser：byAgent 一起拉取并经 agentLookup 补名字', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const findName = vi.fn(async (id: number) => (id === 9 ? '小助手' : null));
    const { service, repo } = build({ findName });
    (repo.aggregateByAgent as ReturnType<typeof vi.fn>).mockResolvedValue([
      { agentId: 9, agentName: null, callCount: 40, failCount: 2, totalTokens: 400, cost: 1.25 },
      { agentId: 11, agentName: null, callCount: 5, failCount: 0, totalTokens: 50, cost: 0 },
      { agentId: null, agentName: null, callCount: 14, failCount: 0, totalTokens: 30, cost: 0 },
    ]);
    const result = await service.summaryForUser(7, 'today');
    expect(repo.aggregateByAgent).toHaveBeenCalledWith(7, expect.objectContaining({ startAt: '2026-10-10 00:00:00' }));
    expect(result.byAgent).toEqual([
      { agentId: 9, agentName: '小助手', callCount: 40, failCount: 2, totalTokens: 400, cost: 1.25 },
      // Agent 已删/查不到名字 → null，前端兜底展示；无归属调用（agent_id NULL）不查名字
      { agentId: 11, agentName: null, callCount: 5, failCount: 0, totalTokens: 50, cost: 0 },
      { agentId: null, agentName: null, callCount: 14, failCount: 0, totalTokens: 30, cost: 0 },
    ]);
    expect(findName).toHaveBeenCalledTimes(2);
    expect(findName).toHaveBeenCalledWith(9);
    expect(findName).toHaveBeenCalledWith(11);
    vi.useRealTimers();
  });

  /** 冻结到上海时区 2026-10-10 12:00，窗口断言不随真实日期漂移。 */
  function freeze(date: Date) {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  }

  it('summaryForUser：默认 last30 半开窗口，四个聚合均带 userId', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    const result = await service.summaryForUser(7);
    expect(result.range).toBe('last30');
    for (const mock of [repo.aggregateSummary, repo.aggregateByModel, repo.aggregateByScene, repo.aggregateByAgent]) {
      expect(mock).toHaveBeenCalledWith(7, expect.objectContaining({
        startAt: '2026-09-11 00:00:00',
        endAtExclusive: '2026-10-11 00:00:00',
      }));
    }
    vi.useRealTimers();
  });

  it('summaryForUser：今日/昨日窗口（2026-10-10 为周六，本周一为 10-05，月初为 10-01）', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    await service.summaryForUser(7, 'today');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-10-10 00:00:00',
      endAtExclusive: '2026-10-11 00:00:00',
    }));
    await service.summaryForUser(7, 'yesterday');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-10-09 00:00:00',
      endAtExclusive: '2026-10-10 00:00:00',
    }));
    await service.summaryForUser(7, 'week');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-10-05 00:00:00',
      endAtExclusive: '2026-10-11 00:00:00',
    }));
    await service.summaryForUser(7, 'month');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-10-01 00:00:00',
      endAtExclusive: '2026-10-11 00:00:00',
    }));
    await service.summaryForUser(7, 'last7');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-10-04 00:00:00',
      endAtExclusive: '2026-10-11 00:00:00',
    }));
    vi.useRealTimers();
  });

  it('summaryForUser：非法 range 回落 last30', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    const result = await service.summaryForUser(7, 'last365' as never);
    expect(result.range).toBe('last30');
    expect(repo.aggregateSummary).toHaveBeenCalledWith(7, expect.objectContaining({ startAt: '2026-09-11 00:00:00' }));
    vi.useRealTimers();
  });

  it('summaryForUser：上周/上月窗口（2026-10-10 为周六，本周一 10-05，故上周 09-28..10-04，上月 09-01..09-30）', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    await service.summaryForUser(7, 'lastWeek');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-09-28 00:00:00',
      endAtExclusive: '2026-10-05 00:00:00',
    }));
    await service.summaryForUser(7, 'lastMonth');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-09-01 00:00:00',
      endAtExclusive: '2026-10-01 00:00:00',
    }));
    vi.useRealTimers();
  });

  it('summaryForUser：custom 用调用方给的起止日，缺 boundary 回落 last30 口径', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    await service.summaryForUser(7, 'custom', { startDate: '2026-08-01', endDate: '2026-08-15' });
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-08-01 00:00:00',
      endAtExclusive: '2026-08-16 00:00:00',
    }));
    // 日期缺省（前端两个日期都必填，这里兜底防直接调用）：等同 last30
    await service.summaryForUser(7, 'custom');
    expect(repo.aggregateSummary).toHaveBeenLastCalledWith(7, expect.objectContaining({
      startAt: '2026-09-11 00:00:00',
      endAtExclusive: '2026-10-11 00:00:00',
    }));
    vi.useRealTimers();
  });

  it('trendsForUser：custom 窗口按日历日补零（上周 7 天、上月 30 天、自定义 5 天）', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service } = build();
    const week = await service.trendsForUser(7, 'lastWeek');
    expect(week.buckets.map((b) => b.bucket)).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
    const month = await service.trendsForUser(7, 'lastMonth');
    expect(month.buckets).toHaveLength(30);
    expect(month.buckets[0].bucket).toBe('2026-09-01');
    expect(month.buckets[29].bucket).toBe('2026-09-30');
    const custom = await service.trendsForUser(7, 'custom', 'day', { startDate: '2026-09-08', endDate: '2026-09-12' });
    expect(custom.range).toBe('custom');
    expect(custom.buckets.map((b) => b.bucket)).toEqual([
      '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12',
    ]);
    vi.useRealTimers();
  });

  it('trendsForUser：窗口一致，granularity 透传且默认 day', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service, repo } = build();
    const day = await service.trendsForUser(7, 'last7');
    expect(day.range).toBe('last7');
    expect(day.granularity).toBe('day');
    // 无数据时补齐 7 个连续零桶（10-04..10-10），前端拿到的序列无缺口
    expect(day.buckets.map((b) => b.bucket)).toEqual([
      '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
    ]);
    // 零桶字段齐全：解码聚合两列（吞吐趋势的分子分母）也补零，前端按固定字段读
    expect(day.buckets.every((b) => b.callCount === 0 && b.totalTokens === 0 && b.cost === 0 && b.decodeTokens === 0 && b.decodeMs === 0)).toBe(true);
    expect(repo.aggregateTrend).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ startAt: '2026-10-04 00:00:00', endAtExclusive: '2026-10-11 00:00:00' }),
      'day',
    );
    await service.trendsForUser(7, 'last7', 'hour');
    expect(repo.aggregateTrend).toHaveBeenLastCalledWith(7, expect.anything(), 'hour');
    vi.useRealTimers();
  });

  it('trendsForUser：day 粒度按窗口日历日补零（本周 6 天、本月至今 10 天）', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service } = build();
    const week = await service.trendsForUser(7, 'week');
    expect(week.buckets.map((b) => b.bucket)).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
    ]);
    const month = await service.trendsForUser(7, 'month');
    // 本月窗口 = 10-01..今天，只补到今天，不出现未来日期
    expect(month.buckets).toHaveLength(10);
    expect(month.buckets[0].bucket).toBe('2026-10-01');
    expect(month.buckets[9].bucket).toBe('2026-10-10');
    vi.useRealTimers();
  });

  it('trendsForUser：hour 粒度含今天只补到当前整点，不出现未来桶', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service } = build();
    const hour = await service.trendsForUser(7, 'today', 'hour');
    expect(hour.granularity).toBe('hour');
    // 窗口=今天：00:00..12:00 共 13 个整点桶
    expect(hour.buckets).toHaveLength(13);
    expect(hour.buckets[0].bucket).toBe('2026-10-10 00:00');
    expect(hour.buckets[12].bucket).toBe('2026-10-10 12:00');
    vi.useRealTimers();
  });

  it('trendsForUser：hour 粒度窗口已结束（昨日）补满全天 24 个整点', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const { service } = build();
    const hour = await service.trendsForUser(7, 'yesterday', 'hour');
    expect(hour.buckets).toHaveLength(24);
    expect(hour.buckets[0].bucket).toBe('2026-10-09 00:00');
    expect(hour.buckets[23].bucket).toBe('2026-10-09 23:00');
    vi.useRealTimers();
  });

  it('trendsForUser：有数据的桶原样保留，其余补零', async () => {
    freeze(new Date('2026-10-10T12:00:00+08:00'));
    const repo = {
      aggregateSummary: vi.fn(),
      aggregateByModel: vi.fn(),
      aggregateByScene: vi.fn(),
      aggregateTrend: vi.fn(async () => [
        { bucket: '2026-10-09', callCount: 3, failCount: 1, cancelledCount: 1, promptTokens: 200, cachedTokens: 80, totalTokens: 300, cost: 0.5, decodeTokens: 150, decodeMs: 3000 },
      ]),
    };
    const service = new LlmCallService(repo as never);
    const day = await service.trendsForUser(7, 'last7');
    expect(day.buckets).toEqual([
      { bucket: '2026-10-04', callCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
      { bucket: '2026-10-05', callCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
      { bucket: '2026-10-06', callCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
      { bucket: '2026-10-07', callCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
      { bucket: '2026-10-08', callCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
      { bucket: '2026-10-09', callCount: 3, failCount: 1, cancelledCount: 1, promptTokens: 200, cachedTokens: 80, totalTokens: 300, cost: 0.5, decodeTokens: 150, decodeMs: 3000 },
      { bucket: '2026-10-10', callCount: 0, failCount: 0, cancelledCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, decodeTokens: 0, decodeMs: 0 },
    ]);
    vi.useRealTimers();
  });
});

describe('LlmCallService 列表项取消派生（/v1/llm-calls、/v1/admin/llm-calls）', () => {
  it('listForAdmin：error_message 含取消标记 → cancelled=1；其余（含 null/其他错误）→ 0', async () => {
    const repo = {
      list: vi.fn(async () => ({
        records: [
          { id: 1, success: 0, errorMessage: 'Cancelled by user' },
          { id: 2, success: 0, errorMessage: 'upstream 500' },
          { id: 3, success: 1, errorMessage: null },
          { id: 4, success: 0, errorMessage: null },
        ],
        total: 4,
      })),
    };
    const service = new LlmCallService(repo as never);
    const { records } = await service.listForAdmin(1, 20, {});
    expect(records.map((r) => [r.id, r.cancelled])).toEqual([[1, 1], [2, 0], [3, 0], [4, 0]]);
  });

  it('listForUser：cancelled 筛选条件透传到 repo.list', async () => {
    const repo = { list: vi.fn(async () => ({ records: [], total: 0 })) };
    const service = new LlmCallService(repo as never);
    await service.listForUser(7, 1, 20, { cancelled: true });
    expect(repo.list).toHaveBeenCalledWith(1, 20, expect.objectContaining({ userId: 7, cancelled: true }));
  });
});

describe('LlmCallService 请求构成透传（技术方案 2026-10-25-run-trace-content-and-prompt §5.2）', () => {
  const CONFIG = { id: 3, name: 'M', provider: 'p', modelId: 'gpt', baseUrl: 'http://x', apiKey: 'k', priceInput: 2, priceCacheRead: 1, priceCacheWrite: 2, priceOutput: 8 };
  const USAGE = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, promptTokensDetails: { cachedTokens: 400 } };

  function buildSelf() {
    const repo = { insert: vi.fn(async () => 1), list: vi.fn(async () => ({ records: [], total: 0 })) };
    const service = new LlmCallService(repo as never, undefined, undefined, undefined);
    return { service, repo };
  }

  it('systemPrompt / toolsJson 原样透传到 insert；缺省时落 NULL', async () => {
    const { service, repo } = buildSelf();
    await LlmCallContext.runAsync({ scene: 'agent', userId: 7, sessionId: 8, agentId: 9 }, async () => {
      await service.record({
        modelConfig: CONFIG,
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
        costMicros: 3200,
        systemPrompt: '你是运维助手',
        toolsJson: '["shell"]',
      });
      await service.record({
        modelConfig: CONFIG,
        stream: true,
        usage: USAGE,
        success: true,
        durationMs: 10,
        costMicros: 3200,
      });
    });
    const calls = repo.insert.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls[0]![0].systemPrompt).toBe('你是运维助手');
    expect(calls[0]![0].toolsJson).toBe('["shell"]');
    // 未采集（旧调用方 / 旁路未接）→ NULL，不伪造空串
    expect(calls[1]![0].systemPrompt).toBeNull();
    expect(calls[1]![0].toolsJson).toBeNull();
  });
});
