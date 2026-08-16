import { describe, expect, it, vi } from 'vitest';
import { AdminAnalyticsDbStore, AdminAnalyticsService } from './admin-analytics.service.js';

describe('AdminAnalyticsService', () => {
  it('summaryAggregatesOverviewTrendsAndBreakdowns', async () => {
    const statistics = { getOverview: vi.fn(async () => ({ totalUsers: 2, totalSessions: 3 })) };
    const store = {
      selectPhaseCounts: vi.fn(async () => [
        { phase: 'RUNNING', count: 2 },
        { phase: 'FAILED', count: 1 },
      ]),
      selectSessionCountsByDay: vi.fn(async () => [{ day: '2026-08-13', count: 4 }]),
      selectMessageCountsByDay: vi.fn(async () => [{ day: '2026-08-13', count: 8 }]),
      listAgents: vi.fn(async () => [{ id: 9, name: 'Coder' }]),
      selectTokenStatsGroupByAgent: vi.fn(async () => [{ agentId: 9, totalTokens: 100, messageCount: 5 }]),
      selectAgentUsageStats: vi.fn(async () => [{ agentId: 9 }]),
      selectSessionCountsByUser: vi.fn(async () => [{ userId: 1, sessionCount: 3 }]),
      selectMessageCountsByUser: vi.fn(async () => [{ userId: 1, messageCount: 7 }]),
      listUsers: vi.fn(async () => [{ id: 1, username: 'ada', displayName: 'Ada' }]),
      selectSessionCountsByModel: vi.fn(async () => [{ modelId: 3, sessionCount: 2 }]),
      selectMessageCountsByModel: vi.fn(async () => [{ modelId: 3, messageCount: 4, totalTokens: 40 }]),
      listModelsOrderByCreatedDesc: vi.fn(async () => [{ id: 3, name: 'gpt' }]),
      listRecentFailedSessions: vi.fn(async () => [{ id: 11, title: 'boom', userId: 1, agentId: 9 }]),
    };
    const service = new AdminAnalyticsService(statistics as never, store as never);
    const result = await service.summary(7);
    expect(result.overview).toMatchObject({ totalUsers: 2, runningSessions: 2, failedSessions: 1 });
    expect(result.trends).toHaveLength(7);
    expect(result.phaseDistribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'RUNNING', count: 2 }),
    ]));
    expect(result.tokenStats[0]).toMatchObject({ agentName: 'Coder', totalTokens: 100 });
    expect(result.userActivity[0]).toMatchObject({ username: 'ada', sessionCount: 3, messageCount: 7 });
    expect(result.modelStats[0]).toMatchObject({ modelName: 'gpt' });
    expect(result.recentFailures[0]).toMatchObject({ id: 11 });
  });
});

describe('AdminAnalyticsDbStore', () => {
  it('issues aggregation queries', async () => {
    const db = { query: vi.fn(async () => []), execute: vi.fn() };
    const store = new AdminAnalyticsDbStore(db as never);
    await store.selectSessionCountsByDay('2026-01-01');
    await store.selectMessageCountsByDay('2026-01-01');
    await store.selectPhaseCounts();
    await store.selectTokenStatsGroupByAgent();
    await store.selectAgentUsageStats();
    await store.selectSessionCountsByUser();
    await store.selectMessageCountsByUser();
    await store.selectSessionCountsByModel();
    await store.selectMessageCountsByModel();
    await store.listAgents();
    await store.listUsers();
    await store.listModelsOrderByCreatedDesc();
    await store.listRecentFailedSessions('2026-01-01', 20);
    expect(db.query).toHaveBeenCalled();
  });
});
