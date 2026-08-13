import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService, type AnalyticsStore } from './analytics.service.js';

function sequential<T>(...values: T[]): () => Promise<T> {
  const queue = [...values];
  return async () => queue.shift() as T;
}

describe('AnalyticsService', () => {
  it('usageTrendsBuildsOneRowPerDay', async () => {
    const store: AnalyticsStore = {
      countSessionsBetween: vi.fn(sequential(1, 2, 3)),
      countMessagesBetween: vi.fn(sequential(10, 20, 30)),
      selectTokenStatsGroupByAgent: vi.fn(),
      listAgents: vi.fn(),
      getAgent: vi.fn(),
      listUsers: vi.fn(),
      countSessionsByUser: vi.fn(),
      listSessionsByUser: vi.fn(),
      countMessagesBySessionIds: vi.fn(),
      listSessionsByAgent: vi.fn(),
      listMessagesBySession: vi.fn(),
    };
    const service = new AnalyticsService(store);
    const result = await service.getUsageTrends(3);
    const trends = result.trends as Array<Record<string, unknown>>;
    expect(trends).toHaveLength(3);
    expect(trends.map((r) => r.sessions)).toEqual([1, 2, 3]);
    expect(trends.map((r) => r.messages)).toEqual([10, 20, 30]);
  });

  it('tokenAnalysisMapsAgentNamesAndSortsByTokens', async () => {
    const store: AnalyticsStore = {
      countSessionsBetween: vi.fn(),
      countMessagesBetween: vi.fn(),
      selectTokenStatsGroupByAgent: vi.fn(async () => [
        { agentId: 2, totalTokens: 50, messageCount: 5 },
        { agentId: 99, totalTokens: 200, messageCount: 10 },
      ]),
      listAgents: vi.fn(async () => [{ id: 2, name: 'Coder' }]),
      getAgent: vi.fn(),
      listUsers: vi.fn(),
      countSessionsByUser: vi.fn(),
      listSessionsByUser: vi.fn(),
      countMessagesBySessionIds: vi.fn(),
      listSessionsByAgent: vi.fn(),
      listMessagesBySession: vi.fn(),
    };
    const service = new AnalyticsService(store);
    const result = await service.getTokenAnalysis();
    const rows = result.agentTokens as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.totalTokens)).toEqual([200, 50]);
    expect(rows[0].agentName).toBe('未知');
    expect(rows[1].agentName).toBe('Coder');
  });

  it('userActivityCountsSessionsAndMessagesThenSorts', async () => {
    const store: AnalyticsStore = {
      countSessionsBetween: vi.fn(),
      countMessagesBetween: vi.fn(),
      selectTokenStatsGroupByAgent: vi.fn(),
      listAgents: vi.fn(),
      getAgent: vi.fn(),
      listUsers: vi.fn(async () => [
        { id: 1, username: 'alice', displayName: 'alice', lastLoginAt: '2024-01-01T12:00' },
        { id: 2, username: 'bob', displayName: 'bob', lastLoginAt: null },
      ]),
      countSessionsByUser: vi.fn(sequential(1, 2)),
      listSessionsByUser: vi.fn()
        .mockResolvedValueOnce([{ id: 10 }, { id: 11 }])
        .mockResolvedValueOnce([]),
      countMessagesBySessionIds: vi.fn(async () => 5),
      listSessionsByAgent: vi.fn(),
      listMessagesBySession: vi.fn(),
    };
    const service = new AnalyticsService(store);
    const result = await service.getUserActivity();
    const rows = result.userActivity as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].username).toBe('alice');
    expect(rows[0].messageCount).toBe(5);
    expect(rows[1].lastLoginAt).toBeNull();
  });

  it('agentEfficiencyReturnsEmptyForMissingAgentAndMetricsForExistingAgent', async () => {
    const store: AnalyticsStore = {
      countSessionsBetween: vi.fn(),
      countMessagesBetween: vi.fn(),
      selectTokenStatsGroupByAgent: vi.fn(),
      listAgents: vi.fn(),
      getAgent: vi.fn(async (id) => (id === 1 ? { id: 1, name: 'Coder' } : null)),
      listUsers: vi.fn(),
      countSessionsByUser: vi.fn(),
      listSessionsByUser: vi.fn(),
      countMessagesBySessionIds: vi.fn(),
      listSessionsByAgent: vi.fn(async () => [{ id: 10 }, { id: 11 }]),
      listMessagesBySession: vi.fn()
        .mockResolvedValueOnce([{ toolCalls: null }, { toolCalls: '[{}]' }])
        .mockResolvedValueOnce([{ toolCalls: null }]),
    };
    const service = new AnalyticsService(store);
    expect(await service.getAgentEfficiency(404)).toEqual({});
    const result = await service.getAgentEfficiency(1);
    expect(result).toMatchObject({
      agentName: 'Coder',
      totalSessions: 2,
      totalMessages: 3,
      toolCallCount: 1,
      avgMessagesPerSession: 1.5,
    });
  });
});
