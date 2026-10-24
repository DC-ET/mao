import { describe, expect, it, vi } from 'vitest';
import { AdminAnalyticsService } from './admin-analytics.service.js';

/**
 * 管理端「会话」分析页的阶段分布必须覆盖全部 phase。
 *
 * sessionsScope 的 periodTotals.sessions 是对 selectPhaseCounts 返回的所有 phase 求和，
 * 而相响应里的 phaseDistribution 只按硬编码 PHASES 枚举展开。CANCELLING（取消中）是
 * 活跃相位（session/util/session-group-key.ts:ACTIVE_PHASES），却不在 PHASES 里：
 * 取消中的会话从饼图蒸发，分布合计与「会话数」自相矛盾。
 */
function makeService(overrides: {
  phaseRows: Array<{ phase: string; count: number }>;
  liveRows: Array<{ phase: string; count: number }>;
}) {
  const store = {
    selectPhaseCounts: vi.fn(async () => overrides.phaseRows),
    selectLivePhaseCounts: vi.fn(async () => overrides.liveRows),
    selectSessionTypeCounts: vi.fn(async () => [{ key: 'NORMAL', count: 5 }]),
    selectExecutionModeCounts: vi.fn(async () => [{ key: 'CLOUD', count: 5 }]),
    countActiveUsers: vi.fn(async () => 1),
    countSessions: vi.fn(async () => 5),
    sumMessages: vi.fn(async () => ({ count: 0, tokens: 0 })),
    sumUsageTokens: vi.fn(async () => 0),
    selectLlmCallQualitySummary: vi.fn(async () => ({
      callCount: 0, successCount: 0, failCount: 0, cancelledCount: 0, retryCallCount: 0,
      promptTokens: 0, cachedTokens: 0, callTokens: 0, cost: 0,
    })),
    countLlmCallLatency: vi.fn(async () => 0),
    selectLlmCallLatencyAtOffset: vi.fn(async () => null),
    selectLlmCallStatsByModel: vi.fn(async () => []),
    selectLlmCallSceneStats: vi.fn(async () => []),
    listModelsOrderByCreatedDesc: vi.fn(async () => []),
  };
  const service = new AdminAnalyticsService(
    { getOverview: vi.fn(async () => ({})) } as never,
    store as never,
  );
  return service;
}

describe('admin 会话阶段分布必须包含 CANCELLING', () => {
  it('phaseDistribution 合计必须等于 periodTotals.sessions', async () => {
    const service = makeService({
      phaseRows: [
        { phase: 'CANCELLING', count: 4 },
        { phase: 'COMPLETED', count: 1 },
      ],
      liveRows: [
        { phase: 'CANCELLING', count: 3 },
        { phase: 'RUNNING', count: 2 },
      ],
    });

    const scope = await service.sessionsScope(1, 0) as {
      phaseDistribution: Array<{ phase: string; count: number }>;
      livePhases: Array<{ phase: string; count: number }>;
      periodTotals: { sessions: number };
    };

    const distributed = scope.phaseDistribution.reduce((sum, row) => sum + row.count, 0);
    expect(distributed).toBe(scope.periodTotals.sessions);
    expect(scope.phaseDistribution.map((row) => row.phase)).toContain('CANCELLING');
    expect(scope.livePhases.map((row) => row.phase)).toContain('CANCELLING');
  });
});
