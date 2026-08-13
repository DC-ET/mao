import { describe, expect, it, vi } from 'vitest';
import { StatisticsService, type StatisticsStore } from './statistics.service.js';

function sequential<T>(...values: T[]): () => Promise<T> {
  const queue = [...values];
  return async () => queue.shift() as T;
}

describe('StatisticsService', () => {
  it('overviewContainsTotalsAndTodayCounts', async () => {
    const store: StatisticsStore = {
      countAgents: vi.fn(async () => 1),
      countModels: vi.fn(async () => 2),
      countUsers: vi.fn(async () => 3),
      countSessions: vi.fn(async () => 4),
      countMessages: vi.fn(async () => 5),
      countSessionsSince: vi.fn(async () => 6),
      countMessagesSince: vi.fn(async () => 7),
      selectAgentUsageStats: vi.fn(),
      listModels: vi.fn(),
      countMessagesByModel: vi.fn(),
      selectTokenCountByModel: vi.fn(),
      sumUsageByModelId: vi.fn(),
      listUsers: vi.fn(),
      countSessionsByUser: vi.fn(),
    };
    const overview = await new StatisticsService(store).getOverview();
    expect(overview).toMatchObject({
      totalAgents: 1,
      totalModels: 2,
      totalUsers: 3,
      totalSessions: 4,
      totalMessages: 5,
      todaySessions: 6,
      todayMessages: 7,
    });
  });

  it('agentStatsIncludesMessageAndTokenCountsForSessions', async () => {
    const expected = [
      { agentId: 1, agentName: 'Coder', sessionCount: 2, messageCount: 3, totalTokens: 25 },
      { agentId: 2, agentName: 'Empty', sessionCount: 0, messageCount: 0, totalTokens: 0 },
    ];
    const store = { selectAgentUsageStats: vi.fn(async () => expected) } as unknown as StatisticsStore;
    const stats = await new StatisticsService(store).getAgentStats();
    expect(stats).toBe(expected);
    expect(stats[0]).toMatchObject({ agentId: 1, agentName: 'Coder', sessionCount: 2, messageCount: 3, totalTokens: 25 });
    expect(stats[1]).toMatchObject({ messageCount: 0, totalTokens: 0 });
  });

  it('modelStatsCountsMessagesPerModel', async () => {
    const store: StatisticsStore = {
      countAgents: vi.fn(),
      countModels: vi.fn(),
      countUsers: vi.fn(),
      countSessions: vi.fn(),
      countMessages: vi.fn(),
      countSessionsSince: vi.fn(),
      countMessagesSince: vi.fn(),
      selectAgentUsageStats: vi.fn(),
      listModels: vi.fn(async () => [{ id: 1, name: 'GPT' }, { id: 2, name: 'Claude' }]),
      countMessagesByModel: vi.fn(sequential(10, 20)),
      selectTokenCountByModel: vi.fn(async (id) => (id === 1 ? 100 : 200)),
      sumUsageByModelId: vi.fn(async (id) => (id === 1
        ? { callCount: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30 }
        : {})),
      listUsers: vi.fn(),
      countSessionsByUser: vi.fn(),
    };
    const stats = await new StatisticsService(store).getModelStats();
    expect(stats.map((r) => r.modelName)).toEqual(['GPT', 'Claude']);
    expect(stats.map((r) => r.messageCount)).toEqual([10, 20]);
    expect(stats[0]).toMatchObject({ backgroundCallCount: 2, messageTokens: 100, totalTokens: 130 });
    expect(stats[1]).toMatchObject({ backgroundTotalTokens: 0, totalTokens: 200 });
  });

  it('userStatsIncludesSessionCountAndLastLogin', async () => {
    const store: StatisticsStore = {
      countAgents: vi.fn(),
      countModels: vi.fn(),
      countUsers: vi.fn(),
      countSessions: vi.fn(),
      countMessages: vi.fn(),
      countSessionsSince: vi.fn(),
      countMessagesSince: vi.fn(),
      selectAgentUsageStats: vi.fn(),
      listModels: vi.fn(),
      countMessagesByModel: vi.fn(),
      selectTokenCountByModel: vi.fn(),
      sumUsageByModelId: vi.fn(),
      listUsers: vi.fn(async () => [
        { id: 1, username: 'alice', displayName: 'alice', lastLoginAt: '2024-01-02T03:04' },
        { id: 2, username: 'bob', displayName: 'bob', lastLoginAt: null },
      ]),
      countSessionsByUser: vi.fn(sequential(4, 0)),
    };
    const stats = await new StatisticsService(store).getUserStats();
    expect(stats[0]).toMatchObject({ username: 'alice', sessionCount: 4 });
    expect(stats[0].lastLoginAt).toBe('2024-01-02T03:04');
    expect(stats[1].lastLoginAt).toBeNull();
  });
});
