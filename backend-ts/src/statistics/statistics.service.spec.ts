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

  it('overviewCountsRunConcurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const counter = () =>
      vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return 1;
      });
    const store: StatisticsStore = {
      countAgents: counter(),
      countModels: counter(),
      countUsers: counter(),
      countSessions: counter(),
      countMessages: counter(),
      countSessionsSince: counter(),
      countMessagesSince: counter(),
      selectAgentUsageStats: vi.fn(),
      listModels: vi.fn(),
      countMessagesByModel: vi.fn(),
      selectTokenCountByModel: vi.fn(),
      sumUsageByModelId: vi.fn(),
      listUsers: vi.fn(),
      countSessionsByUser: vi.fn(),
    };

    await new StatisticsService(store).getOverview();

    // 串行时一次只会有一个计数在途（maxInFlight=1），并行后 7 个同时发出。
    expect(maxInFlight).toBe(7);
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

describe('StatisticsService getOnlineDevices（在线设备实时快照）', () => {
  function storeWithUsers(users: Array<{ id?: number; username?: string; displayName?: string | null }>): StatisticsStore {
    return {
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
      listUsers: vi.fn(async () => users as never),
      countSessionsByUser: vi.fn(),
    };
  }

  it('aggregatesTotalsByClientTypeAndDedupesDevices', async () => {
    const connections = [
      // 同一用户同机：桌面多窗口（同 deviceId）+ CLI 进程（共用 device.json）→ 三条连接一台设备
      { wsSessionId: 'ws-1', userId: 1, clientType: 'electron', connectedAt: 100, authExpiresAt: null, authSource: null, device: { id: 'dev-a', name: 'Mac', platform: 'darwin' } },
      { wsSessionId: 'ws-2', userId: 1, clientType: 'electron', connectedAt: 200, authExpiresAt: null, authSource: null, device: { id: 'dev-a', name: 'Mac', platform: 'darwin' } },
      { wsSessionId: 'ws-3', userId: 1, clientType: 'cli', connectedAt: 300, authExpiresAt: null, authSource: null, device: { id: 'dev-a', name: 'Mac', platform: 'darwin' } },
      // 另一台设备
      { wsSessionId: 'ws-4', userId: 1, clientType: 'cli', connectedAt: 400, authExpiresAt: null, authSource: null, device: { id: 'dev-b', name: 'Win', platform: 'win32' } },
      // 安卓壳：逐条计入设备数
      { wsSessionId: 'ws-5', userId: 2, clientType: 'android', connectedAt: 500, authExpiresAt: null, authSource: null, device: null },
      // 浏览器两条连接：计入连接数，不计入设备数
      { wsSessionId: 'ws-6', userId: 2, clientType: 'browser', connectedAt: 600, authExpiresAt: 999, authSource: 'company_sso', device: null },
      { wsSessionId: 'ws-7', userId: 2, clientType: 'browser', connectedAt: 700, authExpiresAt: null, authSource: null, device: null },
    ];
    const service = new StatisticsService(storeWithUsers([
      { id: 1, username: 'alice', displayName: 'Alice' },
      { id: 2, username: 'bob', displayName: null },
    ]), { listConnections: vi.fn(() => connections as never) });

    const vo = await service.getOnlineDevices();

    expect(vo.total).toEqual({ connections: 7, users: 2, devices: 3 }); // dev-a + dev-b + android 逐条（ws-5）；browser 不计入
    expect(vo.byClientType).toEqual({ electron: 2, android: 1, cli: 2, browser: 2, embed: 0 });
    expect(vo.users.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(vo.users[0].connections).toHaveLength(4);
    expect(vo.users[0].connections[0]).toMatchObject({ wsSessionId: 'ws-1', device: { id: 'dev-a' } });
    expect(vo.users[1].displayName).toBeNull();
    expect(vo.users[1].connections[0]).toMatchObject({ wsSessionId: 'ws-5', authExpiresAt: null });
    expect(vo.users[1].connections[1]).toMatchObject({ wsSessionId: 'ws-6', authExpiresAt: 999, authSource: 'company_sso' });
  });

  it('countsAndroidConnectionsAsDevicesAndExcludesBrowserEmbedFromDevices', async () => {
    const connections = [
      { wsSessionId: 'ws-a', userId: 1, clientType: 'android', connectedAt: 1, authExpiresAt: null, authSource: null, device: null },
      { wsSessionId: 'ws-b', userId: 1, clientType: 'android', connectedAt: 2, authExpiresAt: null, authSource: null, device: null },
      { wsSessionId: 'ws-c', userId: 1, clientType: 'browser', connectedAt: 3, authExpiresAt: null, authSource: null, device: null },
      { wsSessionId: 'ws-d', userId: 1, clientType: 'embed', connectedAt: 4, authExpiresAt: null, authSource: null, device: null },
    ];
    const service = new StatisticsService(storeWithUsers([{ id: 1, username: 'alice' }]), { listConnections: vi.fn(() => connections as never) });

    const vo = await service.getOnlineDevices();

    expect(vo.total).toEqual({ connections: 4, users: 1, devices: 2 });
    expect(vo.byClientType).toEqual({ electron: 0, android: 2, cli: 0, browser: 1, embed: 1 });
  });

  it('placeholdersConnectionsOfDeletedUsers', async () => {
    const connections = [
      { wsSessionId: 'ws-1', userId: 99, clientType: 'cli', connectedAt: 1, authExpiresAt: null, authSource: null, device: { id: 'dev-x', name: 'X', platform: 'linux' } },
    ];
    const service = new StatisticsService(storeWithUsers([{ id: 1, username: 'alice' }]), { listConnections: vi.fn(() => connections as never) });

    const vo = await service.getOnlineDevices();

    expect(vo.total).toEqual({ connections: 1, users: 1, devices: 1 });
    expect(vo.users[0]).toMatchObject({ userId: 99, username: '(已删除用户)', displayName: null });
  });

  it('returnsEmptySnapshotWithoutRegistryInjected', async () => {
    const service = new StatisticsService(storeWithUsers([{ id: 1, username: 'alice' }]));
    const vo = await service.getOnlineDevices();
    expect(vo.total).toEqual({ connections: 0, users: 0, devices: 0 });
    expect(vo.byClientType).toEqual({ electron: 0, android: 0, cli: 0, browser: 0, embed: 0 });
    expect(vo.users).toEqual([]);
  });
});
