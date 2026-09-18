import { describe, expect, it, vi } from 'vitest';
import { addDaysYmd, shanghaiYmd } from '../common/json.js';
import { AdminAnalyticsDbStore, AdminAnalyticsService, type AnalyticsRange } from './admin-analytics.service.js';

const range: AnalyticsRange = {
  days: 7,
  startYmd: '2026-01-01',
  endYmd: '2026-01-07',
  startAt: '2026-01-01 00:00:00',
  endAtExclusive: '2026-01-08 00:00:00',
};

/** 窗口始终以今天结尾，用今天作为日粒度断言锚点。 */
const today = shanghaiYmd();

function buildStore() {
  return {
    selectLivePhaseCounts: vi.fn(async () => [
      { phase: 'RUNNING', count: 2 },
      { phase: 'FAILED', count: 1 },
    ]),
    selectPhaseCounts: vi.fn(async () => [
      { phase: 'COMPLETED', count: 5 },
      { phase: 'FAILED', count: 2 },
    ]),
    selectDailySessionCounts: vi.fn(async () => [{ day: today, count: 4 }]),
    selectDailyMessageStats: vi.fn(async () => [{ day: today, count: 8, tokens: 800 }]),
    selectDailyUsageStats: vi.fn(async () => [{ day: today, totalTokens: 200, callCount: 3 }]),
    countActiveUsers: vi.fn(async () => 2),
    countSessions: vi.fn(async () => 3),
    sumMessages: vi.fn(async () => ({ count: 6, tokens: 600 })),
    sumUsageTokens: vi.fn(async () => 100),
    listAgents: vi.fn(async () => [{ id: 9, name: 'Coder' }]),
    selectSessionCountsByAgent: vi.fn(async () => [{ id: 9, sessionCount: 4 }]),
    selectMessageStatsByAgent: vi.fn(async () => [{ id: 9, messageCount: 8, totalTokens: 800 }]),
    listUsers: vi.fn(async () => [
      { id: 1, username: 'ada', displayName: 'Ada' },
      { id: 2, username: 'idle', displayName: 'Idle' },
    ]),
    selectSessionCountsByUser: vi.fn(async () => [{ id: 1, sessionCount: 3 }]),
    selectMessageStatsByUser: vi.fn(async () => [{ id: 1, messageCount: 7, totalTokens: 700 }]),
    listModelsOrderByCreatedDesc: vi.fn(async () => [
      { id: 3, name: 'gpt' },
      { id: 4, name: 'idle-model' },
    ]),
    selectSessionCountsByModel: vi.fn(async () => [{ id: 3, sessionCount: 2 }]),
    selectMessageStatsByModel: vi.fn(async () => [{ id: 3, messageCount: 4, totalTokens: 400 }]),
    selectUsageStatsByModel: vi.fn(async () => [{ id: 3, totalTokens: 90, callCount: 2 }]),
    selectSessionTypeCounts: vi.fn(async () => [
      { key: 'NORMAL', count: 4 },
      { key: 'SUBAGENT', count: 2 },
    ]),
    selectExecutionModeCounts: vi.fn(async () => [
      { key: 'CLOUD', count: 5 },
      { key: 'LOCAL', count: 1 },
    ]),
    selectDailyLlmCallStats: vi.fn(async () => [
      {
        day: today,
        callCount: 10,
        failCount: 1,
        promptTokens: 1000,
        cachedTokens: 200,
        callTokens: 1500,
      },
    ]),
    selectLlmCallStatsByModel: vi.fn(async () => [
      {
        id: 3,
        callCount: 8,
        successCount: 7,
        failCount: 1,
        retryCallCount: 2,
        promptTokens: 800,
        completionTokens: 200,
        cachedTokens: 100,
        callTokens: 1000,
        firstTokenMsSum: 4000,
        firstTokenMsCount: 8,
        durationMsSum: 40000,
      },
    ]),
    selectLlmCallSceneStats: vi.fn(async () => [
      { key: 'agent', callCount: 6, failCount: 0, callTokens: 800 },
      { key: 'compaction', callCount: 2, failCount: 1, callTokens: 200 },
    ]),
    selectLlmCallProtocolStats: vi.fn(async () => [
      { key: 'openai-compatible', callCount: 10, failCount: 1, callTokens: 1500 },
    ]),
    selectLlmCallStatsByUser: vi.fn(async () => [{ id: 1, callCount: 9, failCount: 1, callTokens: 1200 }]),
    selectLlmCallStatsByAgent: vi.fn(async () => [{ id: 9, callCount: 8, failCount: 1, callTokens: 1000 }]),
    selectLlmCallQualitySummary: vi.fn(async () => ({
      callCount: 10,
      successCount: 9,
      failCount: 1,
      retryCallCount: 2,
      promptTokens: 1000,
      cachedTokens: 200,
      callTokens: 1500,
    })),
    countLlmCallLatency: vi.fn(async (_range: unknown, column: string) => (column === 'first_token_ms' ? 8 : 10)),
    selectLlmCallLatencyAtOffset: vi.fn(async (_range: unknown, column: string, offset: number) => {
      if (column === 'first_token_ms') return offset <= 3 ? 300 : 2000
      return offset <= 4 ? 2000 : 8000
    }),
  };
}

describe('AdminAnalyticsService', () => {
  it('summaryAggregatesPeriodTrendsStructureAndPreviousWindow', async () => {
    const statistics = { getOverview: vi.fn(async () => ({ totalUsers: 2, totalSessions: 3 })) };
    const store = buildStore();
    const service = new AdminAnalyticsService(statistics as never, store as never);

    const result = (await service.summary(7)) as Record<string, any>;

    expect(result.period).toMatchObject({ days: 7, end: today });
    expect(result.overview).toMatchObject({ totalUsers: 2, runningSessions: 2, failedSessions: 1 });
    expect(result.trends).toHaveLength(7);
    expect(result.trends.at(-1)).toMatchObject({
      date: today,
      sessions: 4,
      messages: 8,
      chatTokens: 800,
      backgroundTokens: 200,
      totalTokens: 1000,
    });
    expect(result.periodTotals).toMatchObject({
      sessions: 4,
      messages: 8,
      totalTokens: 1000,
      activeUsers: 2,
      completedSessions: 5,
      failedSessions: 2,
    });
    expect(result.previousTotals).toMatchObject({ sessions: 3, messages: 6, totalTokens: 700 });
    expect(result.phaseDistribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'COMPLETED', count: 5 }),
    ]));
    expect(result.agentStats[0]).toMatchObject({ agentName: 'Coder', totalTokens: 800, sessionCount: 4 });
    expect(result.modelStats[0]).toMatchObject({
      modelName: 'gpt',
      chatTokens: 400,
      backgroundTokens: 90,
      callTokens: 1000,
      totalTokens: 1490,
      callCount: 8,
      callFailCount: 1,
      callSuccessRate: 87.5,
    });
  });

  it('modelStatsDropsModelsWithoutPeriodUsage', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.summary(7)) as Record<string, any>;

    expect(result.modelStats).toHaveLength(1);
    expect(result.modelStats[0]).toMatchObject({ modelId: 3 });
  });

  it('userActivityDropsUsersWithoutPeriodActivity', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.summary(7)) as Record<string, any>;

    expect(result.userActivity).toHaveLength(1);
    expect(result.userActivity[0]).toMatchObject({ username: 'ada', sessionCount: 3, messageCount: 7, totalTokens: 700 });
  });

  it('summaryClampsDaysWindow', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const store = buildStore();
    const service = new AdminAnalyticsService(statistics as never, store as never);

    const result = (await service.summary(9999)) as Record<string, any>;

    expect(result.period).toMatchObject({ days: 90 });
    expect(result.trends).toHaveLength(90);
  });

  it('summaryShiftsEndDayWithEndOffset', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const store = buildStore();
    const service = new AdminAnalyticsService(statistics as never, store as never);

    const result = (await service.summary(1, 1)) as Record<string, any>;
    const yesterday = addDaysYmd(today, -1);

    expect(result.period).toMatchObject({ days: 1, start: yesterday, end: yesterday });
    expect(result.trends).toHaveLength(1);
    expect(result.trends[0]).toMatchObject({ date: yesterday, sessions: 0, messages: 0 });
  });

  it('overviewReturnsLightPayloadWithSparkAndInsights', async () => {
    const statistics = { getOverview: vi.fn(async () => ({ totalUsers: 2 })) };
    const store = buildStore();
    // 洞察规则：失败率 2/7 ≈ 28.6% 应触发 warn
    store.selectPhaseCounts = vi.fn(async () => [
      { phase: 'COMPLETED', count: 5 },
      { phase: 'FAILED', count: 2 },
    ]);
    const service = new AdminAnalyticsService(statistics as never, store as never);

    const result = (await service.overview(7)) as Record<string, any>;

    expect(result.period).toMatchObject({ days: 7, end: today });
    expect(result.overview).toMatchObject({ totalUsers: 2, runningSessions: 2 });
    expect(result.periodTotals).toMatchObject({
      sessions: 4,
      messages: 8,
      totalTokens: 1000,
      activeUsers: 2,
      completedSessions: 5,
      failedSessions: 2,
    });
    expect(result.spark).toHaveLength(7);
    expect(result.spark.at(-1)).toEqual({ date: today, totalTokens: 1000 });
    expect(result.insights.length).toBeGreaterThan(0);
    expect(result.insights.some((item: any) => item.level === 'warn' && String(item.text).includes('失败率'))).toBe(true);
    // overview 不应拉取模型/用户/Agent 排行
    expect(store.listModelsOrderByCreatedDesc).not.toHaveBeenCalled();
    expect(store.listUsers).not.toHaveBeenCalled();
    expect(store.listAgents).not.toHaveBeenCalled();
  });

  it('overviewEmptyWindowProducesTeachingInsight', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const store = buildStore();
    store.selectPhaseCounts = vi.fn(async () => []);
    store.selectDailySessionCounts = vi.fn(async () => []);
    store.selectDailyMessageStats = vi.fn(async () => []);
    store.selectDailyUsageStats = vi.fn(async () => []);
    store.countActiveUsers = vi.fn(async () => 0);
    const service = new AdminAnalyticsService(statistics as never, store as never);

    const result = (await service.overview(7)) as Record<string, any>;

    expect(result.periodTotals).toMatchObject({ sessions: 0, messages: 0, totalTokens: 0 });
    expect(result.insights[0]).toMatchObject({ level: 'info' });
    expect(String(result.insights[0].text)).toContain('放宽');
  });

  it('trendsScopeReturnsDailySeriesWithoutDimensionStats', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const store = buildStore();
    const service = new AdminAnalyticsService(statistics as never, store as never);

    const result = (await service.trendsScope(7)) as Record<string, any>;

    expect(result.trends).toHaveLength(7);
    expect(result.periodTotals).toMatchObject({ sessions: 4, messages: 8, totalTokens: 1000 });
    expect(result.previousTotals).toMatchObject({ sessions: 3, totalTokens: 700 });
    expect(store.listUsers).not.toHaveBeenCalled();
  });

  it('modelsScopeReturnsModelStatsTokenTotalAndQuality', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.modelsScope(7)) as Record<string, any>;

    expect(result.modelStats).toHaveLength(1);
    expect(result.modelStats[0]).toMatchObject({
      modelId: 3,
      totalTokens: 1490,
      callCount: 8,
      cacheHitRate: 12.5,
      avgFirstTokenMs: 500,
      avgDurationMs: 5000,
    });
    expect(result.periodTotals).toEqual({ totalTokens: 1490 });
    expect(result.sceneStats[0]).toMatchObject({ key: 'agent', callTokens: 800 });
    expect(result.protocolStats[0]).toMatchObject({ key: 'openai-compatible', callCount: 10 });
  });

  it('usersScopeMergesLlmCallColumns', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.usersScope(7, 0, 1)) as Record<string, any>;

    expect(result.userActivity).toHaveLength(1);
    expect(result.userActivity[0]).toMatchObject({
      username: 'ada',
      callCount: 9,
      callFailCount: 1,
      callTokens: 1200,
    });
  });

  it('agentsScopeMergesCallSuccessRate', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.agentsScope(7)) as Record<string, any>;

    expect(result.agentStats[0]).toMatchObject({
      agentId: 9,
      callCount: 8,
      callFailCount: 1,
      callSuccessRate: 87.5,
    });
  });

  it('trendsScopeAddsCallQualitySeries', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.trendsScope(7)) as Record<string, any>;
    const last = result.trends.at(-1);

    expect(last).toMatchObject({
      date: today,
      callCount: 10,
      callFailCount: 1,
      callTokens: 1500,
      callSuccessRate: 90,
      cacheHitRate: 20,
    });
    expect(result.periodTotals).toMatchObject({ callCount: 10, callFailCount: 1, callTokens: 1500 });
    expect(result.callQuality).toMatchObject({ successRate: 90, cacheHitRate: 20, retryRatio: 20 });
  });

  it('sessionsScopeAddsCallQualityPanelAndFailTop', async () => {
    const statistics = { getOverview: vi.fn(async () => ({})) };
    const service = new AdminAnalyticsService(statistics as never, buildStore() as never);

    const result = (await service.sessionsScope(7)) as Record<string, any>;

    expect(result.phaseDistribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'COMPLETED', count: 5 }),
      expect.objectContaining({ phase: 'FAILED', count: 2 }),
    ]));
    expect(result.sessionTypes).toEqual([
      { sessionType: 'NORMAL', count: 4 },
      { sessionType: 'SUBAGENT', count: 2 },
    ]);
    expect(result.executionModes).toEqual([
      { executionMode: 'CLOUD', count: 5 },
      { executionMode: 'LOCAL', count: 1 },
    ]);
    expect(result.livePhases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'RUNNING', count: 2 }),
      expect.objectContaining({ phase: 'FAILED', count: 1 }),
    ]));
    expect(result.periodTotals).toMatchObject({
      sessions: 7,
      completedSessions: 5,
      failedSessions: 2,
      activeUsers: 2,
    });
    expect(result.callQuality).toMatchObject({
      callCount: 10,
      failCount: 1,
      successRate: 90,
      cacheHitRate: 20,
      firstTokenP50: 300,
      durationP95: 8000,
    });
    expect(result.failTop.byModel[0]).toMatchObject({ name: 'gpt', failCount: 1 });
    expect(result.failTop.byScene[0]).toMatchObject({ name: 'compaction', failCount: 1 });
    expect(result.excludeConnectivity).toBe(true);
  });
});

describe('AdminAnalyticsDbStore', () => {
  it('issues range-scoped aggregation queries', async () => {
    const db = { query: vi.fn(async () => []), queryOne: vi.fn(async () => ({ c: 0 })) };
    const store = new AdminAnalyticsDbStore(db as never);

    await store.selectDailySessionCounts(range);
    await store.selectDailyMessageStats(range);
    await store.selectDailyUsageStats(range);
    await store.selectLivePhaseCounts();
    await store.selectPhaseCounts(range);
    await store.selectSessionCountsByAgent(range);
    await store.selectMessageStatsByAgent(range);
    await store.selectSessionCountsByUser(range);
    await store.selectMessageStatsByUser(range);
    await store.selectSessionCountsByModel(range);
    await store.selectMessageStatsByModel(range);
    await store.selectUsageStatsByModel(range);
    await store.selectSessionTypeCounts(range);
    await store.selectExecutionModeCounts(range);
    await store.selectDailyLlmCallStats(range);
    await store.selectLlmCallStatsByModel(range);
    await store.selectLlmCallSceneStats(range);
    await store.selectLlmCallProtocolStats(range);
    await store.selectLlmCallStatsByUser(range);
    await store.selectLlmCallStatsByAgent(range);
    await store.selectLlmCallQualitySummary(range);
    await store.countLlmCallLatency(range, 'duration_ms');
    await store.selectLlmCallLatencyAtOffset(range, 'duration_ms', 0);
    await store.listAgents();
    await store.listUsers();
    await store.listModelsOrderByCreatedDesc();

    expect(db.query.mock.calls.length).toBeGreaterThanOrEqual(17);
    for (const call of db.query.mock.calls) {
      const params = (call as unknown[])[1] as unknown[] | undefined;
      if (params && params.length >= 2) {
        expect(params).toContain('2026-01-01 00:00:00');
        expect(params).toContain('2026-01-08 00:00:00');
      }
    }
  });

  it('aggregates scalar counters via queryOne', async () => {
    const db = {
      query: vi.fn(async () => []),
      queryOne: vi.fn(async () => ({ c: 5, count: 4, tokens: 40 })),
    };
    const store = new AdminAnalyticsDbStore(db as never);

    expect(await store.countActiveUsers(range)).toBe(5);
    expect(await store.countSessions(range)).toBe(5);
    expect(await store.sumMessages(range)).toEqual({ count: 4, tokens: 40 });
    expect(await store.sumUsageTokens(range)).toBe(40);
  });
});
