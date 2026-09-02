import { describe, expect, it, vi } from 'vitest';
import { shanghaiYmd } from '../common/json.js';
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
    listModelsOrderByCreatedDesc: vi.fn(async () => [{ id: 3, name: 'gpt' }]),
    selectSessionCountsByModel: vi.fn(async () => [{ id: 3, sessionCount: 2 }]),
    selectMessageStatsByModel: vi.fn(async () => [{ id: 3, messageCount: 4, totalTokens: 400 }]),
    selectUsageStatsByModel: vi.fn(async () => [{ id: 3, totalTokens: 90, callCount: 2 }]),
    listRecentFailedSessions: vi.fn(async () => [{ id: 11, title: 'boom', userId: 1, agentId: 9 }]),
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
    expect(result.modelStats[0]).toMatchObject({ modelName: 'gpt', chatTokens: 400, backgroundTokens: 90, totalTokens: 490 });
    expect(result.recentFailures[0]).toMatchObject({ id: 11 });
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
    await store.listAgents();
    await store.listUsers();
    await store.listModelsOrderByCreatedDesc();
    await store.listRecentFailedSessions(range, 10);

    expect(db.query).toHaveBeenCalledTimes(16);
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
